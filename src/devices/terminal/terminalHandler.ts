import { randomUUID } from "crypto";
import os from "os";
import { logger } from "../../logger.js";
import { Envelope, event, response } from "../envelope.js";
import {
    CHANNEL_TERMINAL, CLOSE_REASON_IDLE_TIMEOUT, CLOSE_REASON_USER_CLOSED,
    ERROR_INVALID_PAYLOAD, ERROR_SHELL_NOT_ALLOWED, ERROR_SPAWN_FAILED,
    ERROR_TERMINAL_DISABLED, ERROR_TERMINAL_LIMIT_REACHED, OP_ACK, OP_ACTIVITY, OP_CLOSE, OP_CONTEXT, OP_DATA, OP_EXIT,
    OP_OPEN, OP_OPENED, OP_RESIZE, OP_RESYNC, OP_SIGNAL, OP_SNAPSHOT, TerminalAckSchema, TerminalActivity,
    TerminalCloseSchema, TerminalData, TerminalExit, TerminalHeld, TerminalInputSchema, TerminalOpenRefused,
    TerminalOpenSchema, TerminalOpened, TerminalResizeSchema, TerminalResyncPart, TerminalSignalSchema,
    TerminalSnapshotPart, TerminalSnapshotRequestSchema, clampGrid,
} from "./terminal_schema.js";
import { TerminalRegistry } from "./terminalRegistry.js";
import { PtySession, PtySpawnRequest } from "./ptySession.js";
import { ShellResolution } from "./shellAllowlist.js";
import { FlowWindow } from "./flowWindow.js";
import { FrameSplitter, rawBundleBytes } from "./frameSplitter.js";
import { SHELL_CONTEXT_POLL_MILLIS, ShellContextReader, ShellContextTracker } from "./shellContext.js";
import { ScreenMirror } from "./screenMirror.js";

/**
 * The agent's half of the `terminal` channel. 1 per agent run, not per socket: **a shell outlives the
 * connection that opened it.**
 *
 * `open` spawns a shell and answers `opened` with its pid. Its output flows up as `data`, the
 * browser acknowledges what it has drawn with `ack`, and when the window fills the agent **stops
 * reading the pty** rather than buffering, unless skip mode is on (below). `data` from the
 * dashboard is keystrokes, written to the pty. `signal` goes to the foreground process group, from
 * the allowlist only. `close` from the dashboard kills the shell. `resize` sets the grid the watching
 * tabs share. A shell that exits on its own sends `exit` and then `close`. An unknown op is ignored,
 * never fatal.
 *
 * When the socket drops, `suspend` pauses every shell, except in skip mode, and keeps it. The next
 * `hello` lists them with `held`, the dashboard closes any it no longer knows, and `resumeAll`
 * restarts reads after `welcome`. Only `closeAll` kills them, when the agent itself stops. See
 * docs/pinggy-devices/slices/T1b-shells-outlive-the-tab.md in the pinggy_backend repo.
 *
 * A `close` can arrive before `welcome`: the dashboard reconciles while answering `hello`. Nothing
 * here waits for the handshake.
 *
 * Without skip mode, 2 things pause a shell's reads, and neither lifts the other's: a suspended handler,
 * and a full window. A shell is read only when the handler is not suspended and its window is open.
 *
 * **Idle shells expire** (slice T4). A shell with no activity for `terminal_idle_timeout_seconds` is
 * killed here and the dashboard is told `close` with `idle_timeout`. The value comes from `welcome` and
 * has no default: without it this runs no timer, and the dashboard's sweep still ends the shell, later.
 * Activity is any frame in either direction: output read from the pty, keystrokes, resize, signal. A
 * clock reset on only 1 direction closes a slow build underneath somebody watching it. No timer fires
 * while suspended: the close would go into no socket, so an expired shell is ended on the first check
 * after `welcome`. A shell has no cap on its running time (slice T7b): a busy one runs until it is
 * closed.
 *
 * **Shells report what they are doing** (slice T4c). While any shell is open, the process table is
 * read every `SHELL_CONTEXT_POLL_MILLIS`, and a shell whose directory or foreground program changed
 * sends `context`. The poll never counts as activity: a program starting or ending is not a person
 * using the shell. No poll runs while suspended, and `resumeAll` sends every shell's context again,
 * so the dashboard catches up on the gap.
 *
 * **Shells keep their screen** (slice T6). Every bundle that is sent also feeds a headless copy of
 * the browser's emulator, so a tab that attaches can ask for the screen it missed with `snapshot`.
 * The screen stays in memory on this machine and ends with the shell. See
 * docs/pinggy-devices/slices/T6-screen-restore.md in the pinggy_backend repo.
 *
 * **Output never waits** (slice T8). With `terminal_resync` in `welcome` and a mirror, nothing outside
 * this machine pauses a shell. A bundle cut while the window is closed, or the socket is down, is
 * skipped: fed to the mirror, given no seq, not sent. Once every sent byte is acked, and no sooner than
 * `RESYNC_MIN_INTERVAL_MILLIS` after the last, the latest screen goes to every tab as `resync`, then
 * live `data`. After `welcome` a resync goes at once. The only pause left is local: the mirror falling
 * more than `MIRROR_HIGH_WATER_BYTES` behind its parser. See docs/pinggy-devices/slices/T8-output-never-waits.md
 * in the pinggy_backend repo.
 *
 * **No log line here carries a payload.** Ids, pids, byte counts and error codes only. Payloads on
 * this channel are what a person types, and the log line that leaks a password is the one written
 * before that day.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** How often expiry is checked. A shell outlives its limit by at most this. */
export const EXPIRY_CHECK_MILLIS = 5000;
const MILLIS_PER_SECOND = 1000;

/**
 * At most 1 resync per this long (slice T8). Serialising 1000 lines of colored output took about 6 ms,
 * measured on 2026-11-03, so this bounds what a flood costs in CPU, not how stale a tab gets.
 */
export const RESYNC_MIN_INTERVAL_MILLIS = 1000;

/**
 * The mirror's marks (slice T8). The pty pauses with more than the high mark fed and not yet parsed,
 * and resumes at the low mark. A resync waits for that backlog to be parsed, so the high mark bounds its
 * delay: about 50 ms at the 22.5 MB/s `yes` parsed at, measured on 2026-11-03.
 */
export const MIRROR_HIGH_WATER_BYTES = 1024 * 1024;
export const MIRROR_LOW_WATER_BYTES = 256 * 1024;

/**
 * How often a skipping shell tells the dashboard it is busy (slice T8). Far inside the sweep's idle
 * timeout, so a shell printing to nobody is never closed as idle there.
 */
export const ACTIVITY_REPORT_MILLIS = 60_000;

/** The 4 constants above, replaced in tests. */
export interface SkipTuning {
    resyncMinIntervalMillis: number;
    mirrorHighWaterBytes: number;
    mirrorLowWaterBytes: number;
    activityReportMillis: number;
}

const DEFAULT_SKIP_TUNING: SkipTuning = {
    resyncMinIntervalMillis: RESYNC_MIN_INTERVAL_MILLIS,
    mirrorHighWaterBytes: MIRROR_HIGH_WATER_BYTES,
    mirrorLowWaterBytes: MIRROR_LOW_WATER_BYTES,
    activityReportMillis: ACTIVITY_REPORT_MILLIS,
};

export interface TerminalHandlerDependencies {
    send: (frame: Envelope) => void;
    spawn: (request: PtySpawnRequest) => PtySession;
    resolveShell: (requested: string | null | undefined) => ShellResolution;
    registry: TerminalRegistry<PtySession>;
    /** Milliseconds since the epoch. Replaced in tests. */
    now?: () => number;
    /** Reads every shell's directory and foreground program. Absent where there is nothing to read. */
    readShellContexts?: ShellContextReader | null;
    /** The home directory with symlinks resolved, shown as `~`. */
    resolvedHome?: string | null;
    /** Replaced in tests. */
    skipTuning?: Partial<SkipTuning>;
}

/** What 1 open terminal needs beyond its shell: a brake and a bundler. */
interface TerminalStream {
    readonly session: PtySession;
    readonly window: FlowWindow;
    readonly splitter: FrameSplitter;
    /**
     * The screen as the tabs saw it, fed each bundle as it is sent, never as it is read. Null when the
     * headless terminal cannot load, and the shell then works without restore.
     */
    readonly mirror: ScreenMirror | null;
    paused: boolean;
    /** The last `data` seq sent. Counts per terminal from 1, across reconnects, as the dashboard checks it. */
    sentSeq: number;
    /**
     * Bundles cut while the socket is down. At most what was already read when `suspend` paused the
     * pty, so this is bounded by 1 read, not by what the shell prints. Sent first after `welcome`.
     */
    readonly heldBundles: Buffer[];
    /** Moves on every frame in either direction. The idle timeout counts from here. */
    lastActivityMillis: number;
    /**
     * Skip mode (slice T8): bundles feed the mirror and are not sent, until a resync. Stays true while a
     * resync is serialised.
     */
    skipping: boolean;
    /** Skipped since the last resync began. A count, never content. */
    skippedBytes: number;
    /** When the last resync began. 0 before the first. */
    lastResyncAtMillis: number;
    /** Waits out the resync interval. */
    resyncTimer: NodeJS.Timeout | null;
    /**
     * The resync being serialised. Bundles cut meanwhile are not in its screen: they wait unfed in
     * `resyncHeldBundles` and go out after its parts. Held past the window size, they are skipped instead.
     */
    resyncInFlight: Promise<void> | null;
    readonly resyncHeldBundles: Buffer[];
    resyncHeldBytes: number;
    /** Output outran the resync being serialised. The stream stays skipping after it. */
    resyncOverflowed: boolean;
    /** Paused because the mirror fell behind its parser. The only pause in skip mode. */
    mirrorPaused: boolean;
    /** When the dashboard last heard that this skipping shell is busy. */
    lastActivityReportMillis: number;
}

export class TerminalHandler {
    private enabled = true;
    private suspended = false;
    private windowBytes: number | undefined;
    private bundleBytes: number | undefined;
    private idleTimeoutMillis: number | undefined;
    /** `terminal_resync` in `welcome` (slice T8). Off, every shell keeps T2's brake. */
    private resyncEnabled = false;
    /** Paused by `suspend` under T2's brake, so `resumeAll` resumes them if `welcome` turned skip mode on. */
    private readonly pausedBySuspend = new Set<string>();
    private readonly tuning: SkipTuning;
    private expiryTimer: NodeJS.Timeout | null = null;
    private contextTimer: NodeJS.Timeout | null = null;
    private contextPollInFlight = false;
    private readonly contextTracker = new ShellContextTracker();
    private readonly streams = new Map<string, TerminalStream>();

    constructor(private readonly dependencies: TerminalHandlerDependencies) {
        this.tuning = { ...DEFAULT_SKIP_TUNING, ...dependencies.skipTuning };
    }

    /**
     * From welcome. An older dashboard sends no terminal fields, and `terminal_enabled` and the
     * per-device ceiling keep their defaults.
     *
     * The window has no default. A compiled-in one keeps working after the dashboard stops sending
     * the field, and nobody notices until a node falls over, so an agent without one refuses to open
     * a terminal at all.
     */
    configure(terminalEnabled: boolean | undefined, maxTerminalsPerDevice: number | undefined,
              terminalWindowBytes: number | undefined, maxFrameBytes: number,
              idleTimeoutSeconds?: number, terminalResync?: boolean): void {
        if (terminalEnabled !== undefined) this.enabled = terminalEnabled;
        if (maxTerminalsPerDevice !== undefined) this.dependencies.registry.setMaxTerminals(maxTerminalsPerDevice);
        this.windowBytes = terminalWindowBytes;
        this.bundleBytes = rawBundleBytes(maxFrameBytes);
        if (terminalWindowBytes === undefined) {
            logger.info("Terminals unavailable: welcome carried no terminal_window_bytes");
        }
        this.idleTimeoutMillis = positiveMillis(idleTimeoutSeconds);
        this.setSkipMode(terminalResync === true);
        this.startExpiryTimer();
    }

    /**
     * `welcome` turned skip mode on or off. Off, a skipping shell stops skipping without a resync, since
     * this dashboard cannot route one, and its tabs miss what was skipped. `resumeAll` then sets the reads.
     */
    private setSkipMode(enabled: boolean): void {
        if (enabled === this.resyncEnabled) return;
        this.resyncEnabled = enabled;
        for (const stream of this.streams.values()) {
            if (stream.resyncTimer) clearTimeout(stream.resyncTimer);
            stream.resyncTimer = null;
            stream.skipping = false;
            stream.skippedBytes = 0;
            stream.resyncOverflowed = false;
            stream.resyncHeldBundles.splice(0);
            stream.resyncHeldBytes = 0;
            stream.mirrorPaused = false;
        }
    }

    /** Ends every shell past its idle timeout. Runs on a timer; public so a test decides when. */
    expireShells(): void {
        if (this.suspended) return;
        const nowMillis = this.nowMillis();
        for (const [terminalId, stream] of [...this.streams.entries()]) {
            if (this.idleTimeoutMillis !== undefined
                && nowMillis - stream.lastActivityMillis >= this.idleTimeoutMillis) {
                this.expire(terminalId, CLOSE_REASON_IDLE_TIMEOUT);
            }
        }
    }

    handle(envelope: Envelope): void {
        if (envelope.op === OP_OPEN) {
            this.open(envelope);
        } else if (envelope.op === OP_CLOSE) {
            this.closeFromDashboard(envelope);
        } else if (envelope.op === OP_ACK) {
            this.acknowledge(envelope);
        } else if (envelope.op === OP_RESIZE) {
            this.resize(envelope);
        } else if (envelope.op === OP_DATA) {
            this.input(envelope);
        } else if (envelope.op === OP_SIGNAL) {
            this.signal(envelope);
        } else if (envelope.op === OP_SNAPSHOT) {
            void this.snapshot(envelope);
        } else {
            logger.debug("Ignoring unhandled terminal op", { op: envelope.op });
        }
    }

    /**
     * The agent is stopping: interrupted, revoked, or refused for good. Every shell dies with it.
     * A dropped socket is not this; it is `suspend`.
     */
    closeAll(): void {
        this.stopExpiryTimer();
        this.stopContextTimer();
        this.contextTracker.clear();
        this.suspended = false;
        for (const stream of this.streams.values()) {
            if (stream.resyncTimer) clearTimeout(stream.resyncTimer);
            stream.splitter.dispose();
            stream.mirror?.dispose();
        }
        this.streams.clear();
        this.pausedBySuspend.clear();
        this.dependencies.registry.killAll();
    }

    /**
     * The socket dropped and the agent will redial. Under T2's brake every shell stops being read and
     * keeps running: whatever it prints waits in the kernel, and the shell blocks once that buffer is
     * full. In skip mode (slice T8) a shell is read on, and its output is skipped.
     */
    suspend(): void {
        if (this.suspended) return;
        this.suspended = true;
        for (const [terminalId, session] of this.dependencies.registry.entries()) {
            const stream = this.streams.get(terminalId);
            if (stream && this.skipsOutput(stream)) continue;
            try {
                session.pause();
                this.pausedBySuspend.add(terminalId);
            } catch (err) {
                logger.warn("Terminal pause failed", { terminal_id: terminalId, error: errorName(err) });
            }
        }
        logger.info("Terminals suspended until the dashboard is back", { count: this.dependencies.registry.size() });
    }

    /**
     * `welcome` arrived. Every shell the dashboard did not close is read again, except one whose
     * window is still full. That one resumes on the `ack` that reopens it. A shell in skip mode was
     * never paused, and resyncs instead (slice T8).
     */
    resumeAll(): void {
        if (!this.suspended) return;
        this.suspended = false;
        for (const [terminalId, session] of this.dependencies.registry.entries()) {
            const stream = this.streams.get(terminalId);
            if (stream && this.skipsOutput(stream)) {
                this.resumeSkipping(terminalId, stream, session);
                continue;
            }
            if (stream) {
                for (const chunk of stream.heldBundles.splice(0)) {
                    this.sendData(terminalId, chunk);
                }
            }
            if (stream?.paused) continue;
            try {
                session.resume();
            } catch (err) {
                logger.warn("Terminal resume failed", { terminal_id: terminalId, error: errorName(err) });
            }
        }
        this.pausedBySuspend.clear();
        for (const context of this.contextTracker.current()) {
            if (this.streams.has(context.terminal_id)) {
                this.dependencies.send(event(CHANNEL_TERMINAL, OP_CONTEXT, context));
            }
        }
    }

    /**
     * Reads every open shell's directory and foreground program, and sends `context` for each that
     * changed. Runs on a timer while any shell is open; public so a test decides when. Never throws,
     * and never moves a shell's idle clock.
     */
    async pollShellContexts(): Promise<void> {
        const read = this.dependencies.readShellContexts;
        if (!read || this.suspended || this.contextPollInFlight || this.streams.size === 0) return;
        this.contextPollInFlight = true;
        try {
            const terminalIdsByPid = new Map<number, string>();
            for (const [terminalId, stream] of this.streams) {
                terminalIdsByPid.set(stream.session.pid, terminalId);
            }
            const contexts = await read([...terminalIdsByPid.keys()]);
            // The socket may have dropped, or a shell closed, while the process table was read.
            if (this.suspended) return;
            for (const [shellPid, raw] of contexts) {
                const terminalId = terminalIdsByPid.get(shellPid);
                if (!terminalId || !this.streams.has(terminalId)) continue;
                const changed = this.contextTracker.observe(terminalId, raw, this.dependencies.resolvedHome ?? null);
                if (changed) this.dependencies.send(event(CHANNEL_TERMINAL, OP_CONTEXT, changed));
            }
        } catch (err) {
            logger.debug("Shell context poll failed", { error: errorName(err) });
        } finally {
            this.contextPollInFlight = false;
        }
    }

    /** What `hello` lists: every shell still held, so the dashboard can keep it. */
    held(): TerminalHeld[] {
        return this.dependencies.registry.entries().map(([terminalId, session]) => ({
            terminal_id: terminalId, pid: session.pid, shell: session.shell, cols: session.cols, rows: session.rows,
        }));
    }

    private open(envelope: Envelope): void {
        const parsed = TerminalOpenSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            this.refuse(envelope, null, ERROR_INVALID_PAYLOAD, "open payload could not be read.");
            return;
        }
        const request = parsed.data;
        const { registry } = this.dependencies;

        if (!this.enabled || this.windowBytes === undefined || this.bundleBytes === undefined) {
            this.refuse(envelope, request.terminal_id, ERROR_TERMINAL_DISABLED, "Terminals are disabled.");
            return;
        }
        if (registry.has(request.terminal_id) || registry.isFull()) {
            this.refuse(envelope, request.terminal_id, ERROR_TERMINAL_LIMIT_REACHED,
                "Too many terminals are already open on this machine.");
            return;
        }

        const resolution = this.dependencies.resolveShell(request.shell);
        if ("error" in resolution) {
            this.refuse(envelope, request.terminal_id, ERROR_SHELL_NOT_ALLOWED, resolution.error);
            return;
        }

        const cols = clampGrid(request.cols, DEFAULT_COLS);
        const rows = clampGrid(request.rows, DEFAULT_ROWS);

        let session: PtySession;
        try {
            session = this.dependencies.spawn({ shell: resolution.shell, cwd: request.cwd, cols, rows });
        } catch (err) {
            logger.warn("Terminal spawn failed", { terminal_id: request.terminal_id, error: errorName(err) });
            this.refuse(envelope, request.terminal_id, ERROR_SPAWN_FAILED, "The shell could not be started.");
            return;
        }

        if (!registry.add(request.terminal_id, session)) {
            session.kill();
            this.refuse(envelope, request.terminal_id, ERROR_TERMINAL_LIMIT_REACHED,
                "Too many terminals are already open on this machine.");
            return;
        }

        this.startStream(request.terminal_id, session, this.windowBytes, this.bundleBytes);

        logger.info("Terminal opened", { terminal_id: request.terminal_id, pid: session.pid });
        const opened: TerminalOpened = {
            terminal_id: request.terminal_id, pid: session.pid, shell: session.shell, cols, rows,
        };
        this.dependencies.send(response(envelope, OP_OPENED, opened));
    }

    private startStream(terminalId: string, session: PtySession, windowBytes: number, bundleBytes: number): void {
        const stream: TerminalStream = {
            session,
            window: new FlowWindow(windowBytes),
            splitter: new FrameSplitter((chunk) => this.sendData(terminalId, chunk), bundleBytes),
            mirror: ScreenMirror.create(session.cols, session.rows),
            paused: false,
            sentSeq: 0,
            heldBundles: [],
            lastActivityMillis: this.nowMillis(),
            skipping: false,
            skippedBytes: 0,
            lastResyncAtMillis: 0,
            resyncTimer: null,
            resyncInFlight: null,
            resyncHeldBundles: [],
            resyncHeldBytes: 0,
            resyncOverflowed: false,
            mirrorPaused: false,
            lastActivityReportMillis: 0,
        };
        this.streams.set(terminalId, stream);
        this.startContextTimer();

        session.onData((chunk) => {
            stream.lastActivityMillis = this.nowMillis();
            stream.splitter.push(chunk);
        });

        session.onExit((exitCode, signal) => {
            // Only when this exit was not asked for. A close from the dashboard removes first.
            if (this.dependencies.registry.remove(terminalId) === undefined) return;
            // Whatever the shell printed on its way out was read before it died, and is still held.
            stream.splitter.flush();
            stream.splitter.dispose();
            void this.finishExit(terminalId, stream, exitCode, signal);
        });
    }

    /**
     * The shell exited on its own. A shell that skipped its last output sends its last screen first, at
     * once, so the tabs see how it ended (slice T8). Then `exit` and `close`. With nothing to resync this
     * runs to the end without yielding, as before.
     */
    private async finishExit(terminalId: string, stream: TerminalStream, exitCode: number,
                             signal: number | undefined): Promise<void> {
        if (this.skipsOutput(stream)) {
            if (stream.resyncInFlight) await stream.resyncInFlight;
            if (stream.skipping && !this.suspended) await this.resync(terminalId, stream);
        }
        this.forgetStream(terminalId);

        logger.info("Terminal shell exited", { terminal_id: terminalId, exit_code: exitCode, signal });
        const exit: TerminalExit = signal
            ? { terminal_id: terminalId, exit_code: null, signal: signalName(signal) }
            : { terminal_id: terminalId, exit_code: exitCode, signal: null };
        this.dependencies.send(event(CHANNEL_TERMINAL, OP_EXIT, exit));
        this.dependencies.send(event(CHANNEL_TERMINAL, OP_CLOSE,
            { terminal_id: terminalId, reason: CLOSE_REASON_USER_CLOSED }));
    }

    /**
     * 1 bundle leaves, and the window narrows by what it carried.
     *
     * The pause happens after the send rather than before. These bytes are already out of the pty,
     * and holding them is the buffering this whole mechanism exists to avoid.
     *
     * While the socket is down the bundle is held instead, and neither counts against the window nor
     * takes a seq. Sent into no socket, it would be a seq the dashboard never sees and bytes nobody
     * can ack, and the window would never reopen.
     *
     * The mirror is fed here, in the same tick as the seq, and nowhere else. A snapshot then holds
     * exactly the bundles up to its `after_seq`. Fed when the pty is read, a bundle still being cut
     * would be in the screen and drawn a second time when it is sent.
     *
     * In skip mode (slice T8) `sendOrSkip` decides instead, and never pauses the pty.
     */
    private sendData(terminalId: string, chunk: Buffer): void {
        const stream = this.streams.get(terminalId);
        if (!stream) return;
        if (this.skipsOutput(stream)) {
            this.sendOrSkip(terminalId, stream, chunk);
            return;
        }
        if (this.suspended) {
            stream.heldBundles.push(chunk);
            return;
        }

        stream.sentSeq += 1;
        stream.mirror?.feed(chunk);
        const data: TerminalData = { terminal_id: terminalId, data: chunk.toString("base64") };
        this.dependencies.send({ ...event(CHANNEL_TERMINAL, OP_DATA, data), seq: stream.sentSeq });
        stream.window.recordSent(chunk.length);

        if (!stream.window.isOpen() && !stream.paused) {
            stream.paused = true;
            stream.session.pause();
            logger.debug("Terminal window full, reads paused", { terminal_id: terminalId });
        }
    }

    /** Skip mode applies: `welcome` asked for it, and the shell has a screen to resync with. */
    private skipsOutput(stream: TerminalStream): boolean {
        return this.resyncEnabled && stream.mirror !== null;
    }

    /**
     * Skip mode (slice T8). A resync being serialised holds the bundle. A skipping stream, a socket that is
     * down, or a closed window skips it. Otherwise it goes out as `data`.
     */
    private sendOrSkip(terminalId: string, stream: TerminalStream, chunk: Buffer): void {
        if (stream.resyncInFlight) {
            this.holdDuringResync(terminalId, stream, chunk);
        } else if (stream.skipping || this.suspended || !stream.window.isOpen()) {
            this.skip(terminalId, stream, chunk);
        } else {
            this.transmit(terminalId, stream, chunk);
        }
    }

    /**
     * A bundle cut while a resync is serialised is not in its screen, so it waits and goes out after the
     * parts. Past the window size the held bundles are skipped instead, and the stream stays skipping.
     */
    private holdDuringResync(terminalId: string, stream: TerminalStream, chunk: Buffer): void {
        if (!stream.resyncOverflowed && stream.resyncHeldBytes + chunk.length <= (this.windowBytes ?? 0)) {
            stream.resyncHeldBundles.push(chunk);
            stream.resyncHeldBytes += chunk.length;
            return;
        }
        if (!stream.resyncOverflowed) {
            stream.resyncOverflowed = true;
            this.skipHeldDuringResync(terminalId, stream);
        }
        this.skip(terminalId, stream, chunk);
    }

    private skipHeldDuringResync(terminalId: string, stream: TerminalStream): void {
        const held = stream.resyncHeldBundles.splice(0);
        stream.resyncHeldBytes = 0;
        for (const chunk of held) {
            this.skip(terminalId, stream, chunk);
        }
    }

    /** Into the screen, not onto the wire. It takes no seq, and the window never counts it. */
    private skip(terminalId: string, stream: TerminalStream, chunk: Buffer): void {
        stream.mirror?.feed(chunk, () => this.mirrorParsed(terminalId, stream));
        stream.skippedBytes += chunk.length;
        if (!stream.skipping) {
            stream.skipping = true;
            logger.debug("Terminal output skipped until the tabs catch up", { terminal_id: terminalId });
        }
        this.brakeIfMirrorBehind(terminalId, stream);
        this.reportActivityWhileSkipping(terminalId, stream);
    }

    /** As T2's send, minus the pause: with the window closed, the next bundle is skipped instead. */
    private transmit(terminalId: string, stream: TerminalStream, chunk: Buffer): void {
        stream.sentSeq += 1;
        stream.mirror?.feed(chunk, () => this.mirrorParsed(terminalId, stream));
        const data: TerminalData = { terminal_id: terminalId, data: chunk.toString("base64") };
        this.dependencies.send({ ...event(CHANNEL_TERMINAL, OP_DATA, data), seq: stream.sentSeq });
        stream.window.recordSent(chunk.length);
        this.brakeIfMirrorBehind(terminalId, stream);
    }

    /** The one pause in skip mode: the mirror's parser fell behind. Local CPU, never the network. */
    private brakeIfMirrorBehind(terminalId: string, stream: TerminalStream): void {
        if (stream.mirrorPaused || !stream.mirror
            || stream.mirror.backlogBytes <= this.tuning.mirrorHighWaterBytes) return;
        stream.mirrorPaused = true;
        stream.session.pause();
        logger.debug("Terminal reads paused until the screen catches up", { terminal_id: terminalId });
    }

    private mirrorParsed(terminalId: string, stream: TerminalStream): void {
        if (!stream.mirrorPaused || !stream.mirror
            || stream.mirror.backlogBytes > this.tuning.mirrorLowWaterBytes) return;
        stream.mirrorPaused = false;
        if (this.streams.get(terminalId) !== stream) return;
        try {
            stream.session.resume();
        } catch (err) {
            logger.debug("Terminal resume failed", { terminal_id: terminalId, error: errorName(err) });
        }
    }

    /**
     * Skipped output never reaches the dashboard, so its sweep would see an idle shell. At most every
     * `ACTIVITY_REPORT_MILLIS` it hears that this one is busy.
     */
    private reportActivityWhileSkipping(terminalId: string, stream: TerminalStream): void {
        if (this.suspended) return;
        const nowMillis = this.nowMillis();
        if (nowMillis - stream.lastActivityReportMillis < this.tuning.activityReportMillis) return;
        stream.lastActivityReportMillis = nowMillis;
        const activity: TerminalActivity = { terminal_id: terminalId, skipped_bytes: stream.skippedBytes };
        this.dependencies.send(event(CHANNEL_TERMINAL, OP_ACTIVITY, activity));
    }

    /**
     * Skip mode after `welcome`. A shell that skipped, or had bytes in flight, resyncs at once: frames in
     * flight died with the old socket, and the tab's ack of the resync's `after_bytes` stands in for theirs.
     */
    private resumeSkipping(terminalId: string, stream: TerminalStream, session: PtySession): void {
        stream.paused = false;
        // Held by T2's brake before this welcome turned skip mode on. Never sent, so skipped now.
        for (const chunk of stream.heldBundles.splice(0)) {
            this.skip(terminalId, stream, chunk);
        }
        if (this.pausedBySuspend.has(terminalId) && !stream.mirrorPaused) {
            try {
                session.resume();
            } catch (err) {
                logger.warn("Terminal resume failed", { terminal_id: terminalId, error: errorName(err) });
            }
        }
        if (stream.skipping || stream.window.sent > stream.window.acked) {
            void this.resync(terminalId, stream);
        }
    }

    /** Every sent byte is acked: the tabs have drawn everything they were sent. */
    private static isDrained(stream: TerminalStream): boolean {
        return stream.window.acked >= stream.window.sent;
    }

    /**
     * A skipping stream resyncs once its window has drained, and no sooner than the interval after the
     * last resync. Not drained yet, it waits for the next `ack`.
     */
    private scheduleResync(terminalId: string, stream: TerminalStream): void {
        if (!stream.skipping || stream.resyncInFlight || stream.resyncTimer || this.suspended
            || !TerminalHandler.isDrained(stream)) return;
        const waitMillis = stream.lastResyncAtMillis + this.tuning.resyncMinIntervalMillis - this.nowMillis();
        if (waitMillis <= 0) {
            void this.resync(terminalId, stream);
            return;
        }
        stream.resyncTimer = setTimeout(() => {
            stream.resyncTimer = null;
            if (this.streams.get(terminalId) === stream) this.scheduleResync(terminalId, stream);
        }, waitMillis);
        // A timer must not be what keeps a stopping agent alive.
        stream.resyncTimer.unref();
    }

    /** Starts a resync, or returns the one already being serialised. */
    private resync(terminalId: string, stream: TerminalStream): Promise<void> {
        if (stream.resyncInFlight) return stream.resyncInFlight;
        if (stream.resyncTimer) clearTimeout(stream.resyncTimer);
        stream.resyncTimer = null;
        stream.resyncInFlight = this.serialiseAndSendResync(terminalId, stream);
        return stream.resyncInFlight;
    }

    /**
     * The latest screen to every tab (slice T8). `after_seq` and `after_bytes` are read before the mirror
     * is asked, as for a snapshot, and skipped bytes took neither: the screen holds the output up to
     * `after_seq` plus everything skipped. Serialised under the window size, so a resync never puts more in
     * flight than the window allows. Bundles held meanwhile go out after the parts, from `after_seq + 1`.
     */
    private async serialiseAndSendResync(terminalId: string, stream: TerminalStream): Promise<void> {
        stream.lastResyncAtMillis = this.nowMillis();
        stream.resyncOverflowed = false;
        const afterSeq = stream.sentSeq;
        const afterBytes = stream.window.sent;
        const skippedBytes = stream.skippedBytes;
        stream.skippedBytes = 0;
        const screen = stream.mirror ? await stream.mirror.snapshot(this.windowBytes) : null;
        stream.resyncInFlight = null;
        if (this.streams.get(terminalId) !== stream) return;
        if (this.suspended) {
            // The socket dropped while the screen was read. resumeAll resyncs again.
            stream.skippedBytes += skippedBytes;
            this.skipHeldDuringResync(terminalId, stream);
            stream.resyncOverflowed = false;
            return;
        }

        if (screen && this.bundleBytes !== undefined) {
            const resyncId = randomUUID();
            const parts = splitIntoParts(Buffer.from(screen.text, "utf-8"), this.bundleBytes);
            parts.forEach((part, index) => {
                const payload: TerminalResyncPart = {
                    terminal_id: terminalId, resync_id: resyncId, part: index, last: index === parts.length - 1,
                    after_seq: afterSeq, after_bytes: afterBytes, skipped_bytes: skippedBytes,
                    cols: screen.cols, rows: screen.rows, data: part.toString("base64"),
                };
                this.dependencies.send(event(CHANNEL_TERMINAL, OP_RESYNC, payload));
            });
            logger.debug("Terminal resynced", {
                terminal_id: terminalId, parts: parts.length, after_seq: afterSeq, skipped_bytes: skippedBytes,
            });
        } else {
            // Even the screen alone is over 1 MB. Live output beats a tab that never catches up.
            logger.warn("Terminal resync dropped: the screen is too large to send", { terminal_id: terminalId });
        }

        if (stream.resyncOverflowed) {
            stream.resyncOverflowed = false;
            this.scheduleResync(terminalId, stream);
            return;
        }
        stream.skipping = false;
        const held = stream.resyncHeldBundles.splice(0);
        stream.resyncHeldBytes = 0;
        for (const chunk of held) {
            this.sendOrSkip(terminalId, stream, chunk);
        }
    }

    private acknowledge(envelope: Envelope): void {
        const parsed = TerminalAckSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const stream = this.streams.get(parsed.data.terminal_id);
        if (!stream) return;

        stream.window.recordAck(parsed.data.ack_bytes);
        if (this.skipsOutput(stream)) {
            this.scheduleResync(parsed.data.terminal_id, stream);
            return;
        }
        if (stream.paused && stream.window.isOpen()) {
            stream.paused = false;
            // Suspended means the socket is down, and resumeAll restarts reads once it is back.
            if (this.suspended) return;
            stream.session.resume();
            logger.debug("Terminal window reopened, reads resumed", { terminal_id: parsed.data.terminal_id });
        }
    }

    private closeFromDashboard(envelope: Envelope): void {
        const parsed = TerminalCloseSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const session = this.dependencies.registry.remove(parsed.data.terminal_id);
        if (!session) return;
        const stream = this.streams.get(parsed.data.terminal_id);
        this.forgetStream(parsed.data.terminal_id);
        stream?.splitter.dispose();
        logger.info("Terminal closed by the dashboard", { terminal_id: parsed.data.terminal_id, pid: session.pid });
        try {
            session.kill();
        } catch {
            // Already exited.
        }
    }

    /**
     * The tabs watching this shell changed size. Clamped like `open`, and a gone shell is ignored.
     * The pty is resized only on an actual change: every call is a `TIOCSWINSZ` and a SIGWINCH, and
     * a full-screen program redraws on each one.
     */
    private resize(envelope: Envelope): void {
        const parsed = TerminalResizeSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const session = this.dependencies.registry.get(parsed.data.terminal_id);
        if (!session) return;
        this.markActive(parsed.data.terminal_id);
        const cols = clampGrid(parsed.data.cols, session.cols);
        const rows = clampGrid(parsed.data.rows, session.rows);
        if (cols === session.cols && rows === session.rows) return;
        try {
            session.resize(cols, rows);
            this.streams.get(parsed.data.terminal_id)?.mirror?.resize(cols, rows);
        } catch (err) {
            // Exited between the lookup and the call.
            logger.debug("Terminal resize failed", { terminal_id: parsed.data.terminal_id, error: errorName(err) });
        }
    }

    /** Keystrokes, written as raw bytes. A gone shell is ignored. Never logged: this is what a person typed. */
    private input(envelope: Envelope): void {
        const parsed = TerminalInputSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const session = this.dependencies.registry.get(parsed.data.terminal_id);
        if (!session) return;
        this.markActive(parsed.data.terminal_id);
        try {
            session.write(Buffer.from(parsed.data.data, "base64"));
        } catch (err) {
            // Exited between the lookup and the call.
            logger.debug("Terminal write failed", { terminal_id: parsed.data.terminal_id, error: errorName(err) });
        }
    }

    /** 1 allowlisted signal to the foreground process group. Anything else fails to parse and is dropped. */
    private signal(envelope: Envelope): void {
        const parsed = TerminalSignalSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            logger.debug("Ignoring a terminal signal outside the allowlist");
            return;
        }
        const session = this.dependencies.registry.get(parsed.data.terminal_id);
        if (!session) return;
        this.markActive(parsed.data.terminal_id);
        session.signalForeground(parsed.data.signal);
    }

    private markActive(terminalId: string): void {
        const stream = this.streams.get(terminalId);
        if (stream) stream.lastActivityMillis = this.nowMillis();
    }

    /**
     * Removed from the registry before the kill, so its exit callback finds nothing and sends no
     * `user_closed`. The output already read goes out first, then `close` with the reason.
     */
    private expire(terminalId: string, reason: string): void {
        const session = this.dependencies.registry.remove(terminalId);
        const stream = this.streams.get(terminalId);
        this.forgetStream(terminalId);
        stream?.splitter.flush();
        stream?.splitter.dispose();
        if (!session) return;
        logger.info("Terminal expired", { terminal_id: terminalId, pid: session.pid, reason });
        try {
            session.kill();
        } catch {
            // Already exited.
        }
        this.dependencies.send(event(CHANNEL_TERMINAL, OP_CLOSE, { terminal_id: terminalId, reason }));
    }

    /**
     * A tab attached and asked for the screen it missed (slice T6). Answered in parts, each 1 frame,
     * which the dashboard routes to that tab alone.
     *
     * `after_seq` and `after_bytes` are read in the same tick as the request, before the mirror is
     * asked, so they name exactly the bundles the screen holds. The parts go out even with the window
     * closed: they are not pty output, so they take no seq and the window never counts them. A request
     * for a shell that is gone, or a screen too big to send, is not answered; the tab falls back.
     */
    private async snapshot(envelope: Envelope): Promise<void> {
        const parsed = TerminalSnapshotRequestSchema.safeParse(envelope.payload);
        if (!parsed.success || this.bundleBytes === undefined) return;
        const { terminal_id: terminalId, snapshot_id: snapshotId } = parsed.data;
        const stream = this.streams.get(terminalId);
        if (!stream?.mirror) return;

        const afterSeq = stream.sentSeq;
        const afterBytes = stream.window.sent;
        const screen = await stream.mirror.snapshot();
        // The shell may have ended, or the socket dropped, while the screen was read.
        if (!screen || this.suspended || this.streams.get(terminalId) !== stream) return;

        const parts = splitIntoParts(Buffer.from(screen.text, "utf-8"), this.bundleBytes);
        parts.forEach((part, index) => {
            const payload: TerminalSnapshotPart = {
                terminal_id: terminalId, snapshot_id: snapshotId, part: index, last: index === parts.length - 1,
                after_seq: afterSeq, after_bytes: afterBytes, cols: screen.cols, rows: screen.rows,
                data: part.toString("base64"),
            };
            this.dependencies.send(event(CHANNEL_TERMINAL, OP_SNAPSHOT, payload));
        });
        logger.debug("Terminal screen sent", { terminal_id: terminalId, parts: parts.length, after_seq: afterSeq });
    }

    /** A shell is gone. The context poll stops with the last one, so an idle agent spawns nothing. */
    private forgetStream(terminalId: string): void {
        const stream = this.streams.get(terminalId);
        if (stream?.resyncTimer) clearTimeout(stream.resyncTimer);
        stream?.mirror?.dispose();
        this.streams.delete(terminalId);
        this.contextTracker.forget(terminalId);
        if (this.streams.size === 0) this.stopContextTimer();
    }

    private startContextTimer(): void {
        if (this.contextTimer || !this.dependencies.readShellContexts) return;
        this.contextTimer = setInterval(() => void this.pollShellContexts(), SHELL_CONTEXT_POLL_MILLIS);
        // A timer must not be what keeps a stopping agent alive.
        this.contextTimer.unref();
    }

    private stopContextTimer(): void {
        if (this.contextTimer) {
            clearInterval(this.contextTimer);
            this.contextTimer = null;
        }
    }

    private startExpiryTimer(): void {
        if (this.expiryTimer || this.idleTimeoutMillis === undefined) {
            return;
        }
        this.expiryTimer = setInterval(() => this.expireShells(), EXPIRY_CHECK_MILLIS);
        // A timer must not be what keeps a stopping agent alive.
        this.expiryTimer.unref();
    }

    private stopExpiryTimer(): void {
        if (this.expiryTimer) {
            clearInterval(this.expiryTimer);
            this.expiryTimer = null;
        }
    }

    private nowMillis(): number {
        return this.dependencies.now ? this.dependencies.now() : Date.now();
    }

    private refuse(envelope: Envelope, terminalId: string | null, code: string, message: string): void {
        logger.info("Terminal open refused", { terminal_id: terminalId, code });
        const refused: TerminalOpenRefused = { terminal_id: terminalId, error: { code, message } };
        this.dependencies.send(response(envelope, OP_OPENED, refused));
    }
}

/** Undefined unless the dashboard sent a positive number. There is no default. */
function positiveMillis(seconds: number | undefined): number | undefined {
    return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds * MILLIS_PER_SECOND : undefined;
}

/**
 * At least 1 part, so an empty screen still ends in a `last` part and the tab never waits out its
 * fallback for a shell that has printed nothing. A cut can split a character; the tab's xterm joins
 * the halves, as it does for `data`.
 */
function splitIntoParts(bytes: Buffer, partBytes: number): Buffer[] {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += partBytes) {
        parts.push(bytes.subarray(offset, offset + partBytes));
    }
    return parts.length > 0 ? parts : [Buffer.alloc(0)];
}

/** The error's class name only. A message can quote the command line it failed on. */
function errorName(err: unknown): string {
    return err instanceof Error ? err.name : typeof err;
}

/**
 * The wire names a signal, the pty reports a number. An unmapped number is reported as its own
 * digits rather than dropped, because "killed by something" is more use than a null.
 */
function signalName(signal: number): string {
    for (const [name, number] of Object.entries(os.constants.signals)) {
        if (number === signal) return name.replace(/^SIG/, "");
    }
    return String(signal);
}
