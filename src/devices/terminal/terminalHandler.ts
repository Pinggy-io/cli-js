import os from "os";
import { logger } from "../../logger.js";
import { Envelope, event, response } from "../envelope.js";
import {
    CHANNEL_TERMINAL, CLOSE_REASON_IDLE_TIMEOUT, CLOSE_REASON_MAX_SESSION, CLOSE_REASON_USER_CLOSED,
    ERROR_INVALID_PAYLOAD, ERROR_SHELL_NOT_ALLOWED, ERROR_SPAWN_FAILED,
    ERROR_TERMINAL_DISABLED, ERROR_TERMINAL_LIMIT_REACHED, OP_ACK, OP_CLOSE, OP_CONTEXT, OP_DATA, OP_EXIT, OP_OPEN,
    OP_OPENED, OP_RESIZE, OP_SIGNAL, TerminalAckSchema, TerminalCloseSchema, TerminalData, TerminalExit, TerminalHeld,
    TerminalInputSchema, TerminalOpenRefused, TerminalOpenSchema, TerminalOpened, TerminalResizeSchema,
    TerminalSignalSchema, clampGrid,
} from "./terminal_schema.js";
import { TerminalRegistry } from "./terminalRegistry.js";
import { PtySession, PtySpawnRequest } from "./ptySession.js";
import { ShellResolution } from "./shellAllowlist.js";
import { FlowWindow } from "./flowWindow.js";
import { FrameSplitter, rawBundleBytes } from "./frameSplitter.js";
import { SHELL_CONTEXT_POLL_MILLIS, ShellContextReader, ShellContextTracker } from "./shellContext.js";

/**
 * The agent's half of the `terminal` channel. 1 per agent run, not per socket: **a shell outlives the
 * connection that opened it.**
 *
 * `open` spawns a shell and answers `opened` with its pid. Its output flows up as `data`, the
 * browser acknowledges what it has drawn with `ack`, and when the window fills the agent **stops
 * reading the pty** rather than buffering. `data` from the dashboard is keystrokes, written to the
 * pty. `signal` goes to the foreground process group, from the allowlist only. `close` from the
 * dashboard kills the shell. `resize` sets the grid the watching tabs share. A shell that exits on
 * its own sends `exit` and then `close`. An unknown op is ignored, never fatal.
 *
 * When the socket drops, `suspend` pauses every shell and keeps it. The next `hello` lists them with
 * `held`, the dashboard closes any it no longer knows, and `resumeAll` restarts reads after
 * `welcome`. Only `closeAll` kills them, when the agent itself stops. See
 * docs/pinggy-devices/slices/T1b-shells-outlive-the-tab.md in the pinggy_backend repo.
 *
 * A `close` can arrive before `welcome`: the dashboard reconciles while answering `hello`. Nothing
 * here waits for the handshake.
 *
 * 2 things pause a shell's reads, and neither lifts the other's: a suspended handler, and a full
 * window. A shell is read only when the handler is not suspended and its window is open.
 *
 * **Shells expire** (slice T4). A shell with no activity for `terminal_idle_timeout_seconds`, or open
 * for `terminal_max_session_seconds`, is killed here and the dashboard is told `close` with
 * `idle_timeout` or `max_session`. Both values come from `welcome` and have no default: without them
 * this runs no timer, and the dashboard's sweep still ends the shell, later. Activity is any frame in
 * either direction: output read from the pty, keystrokes, resize, signal. A clock reset on only 1
 * direction closes a slow build underneath somebody watching it. No timer fires while suspended: the
 * close would go into no socket, so an expired shell is ended on the first check after `welcome`.
 *
 * **Shells report what they are doing** (slice T4c). While any shell is open, the process table is
 * read every `SHELL_CONTEXT_POLL_MILLIS`, and a shell whose directory or foreground program changed
 * sends `context`. The poll never counts as activity: a program starting or ending is not a person
 * using the shell. No poll runs while suspended, and `resumeAll` sends every shell's context again,
 * so the dashboard catches up on the gap.
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
}

/** What 1 open terminal needs beyond its shell: a brake and a bundler. */
interface TerminalStream {
    readonly session: PtySession;
    readonly window: FlowWindow;
    readonly splitter: FrameSplitter;
    paused: boolean;
    /** The last `data` seq sent. Counts per terminal from 1, across reconnects, as the dashboard checks it. */
    sentSeq: number;
    /**
     * Bundles cut while the socket is down. At most what was already read when `suspend` paused the
     * pty, so this is bounded by 1 read, not by what the shell prints. Sent first after `welcome`.
     */
    readonly heldBundles: Buffer[];
    /** Where the max-session cap counts from. */
    readonly openedAtMillis: number;
    /** Moves on every frame in either direction. The idle timeout counts from here. */
    lastActivityMillis: number;
}

export class TerminalHandler {
    private enabled = true;
    private suspended = false;
    private windowBytes: number | undefined;
    private bundleBytes: number | undefined;
    private idleTimeoutMillis: number | undefined;
    private maxSessionMillis: number | undefined;
    private expiryTimer: NodeJS.Timeout | null = null;
    private contextTimer: NodeJS.Timeout | null = null;
    private contextPollInFlight = false;
    private readonly contextTracker = new ShellContextTracker();
    private readonly streams = new Map<string, TerminalStream>();

    constructor(private readonly dependencies: TerminalHandlerDependencies) {
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
              idleTimeoutSeconds?: number, maxSessionSeconds?: number): void {
        if (terminalEnabled !== undefined) this.enabled = terminalEnabled;
        if (maxTerminalsPerDevice !== undefined) this.dependencies.registry.setMaxTerminals(maxTerminalsPerDevice);
        this.windowBytes = terminalWindowBytes;
        this.bundleBytes = rawBundleBytes(maxFrameBytes);
        if (terminalWindowBytes === undefined) {
            logger.info("Terminals unavailable: welcome carried no terminal_window_bytes");
        }
        this.idleTimeoutMillis = positiveMillis(idleTimeoutSeconds);
        this.maxSessionMillis = positiveMillis(maxSessionSeconds);
        this.startExpiryTimer();
    }

    /**
     * Ends every shell past its idle timeout or its max-session cap. Runs on a timer; public so a test
     * decides when. The cap goes first: a shell both idle and too old is closed for the rule typing
     * cannot reset.
     */
    expireShells(): void {
        if (this.suspended) return;
        const nowMillis = this.nowMillis();
        for (const [terminalId, stream] of [...this.streams.entries()]) {
            if (this.maxSessionMillis !== undefined && nowMillis - stream.openedAtMillis >= this.maxSessionMillis) {
                this.expire(terminalId, CLOSE_REASON_MAX_SESSION);
            } else if (this.idleTimeoutMillis !== undefined
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
            stream.splitter.dispose();
        }
        this.streams.clear();
        this.dependencies.registry.killAll();
    }

    /**
     * The socket dropped and the agent will redial. Every shell stops being read and keeps running.
     * Whatever it prints waits in the kernel, and the shell blocks once that buffer is full.
     */
    suspend(): void {
        if (this.suspended) return;
        this.suspended = true;
        for (const [terminalId, session] of this.dependencies.registry.entries()) {
            try {
                session.pause();
            } catch (err) {
                logger.warn("Terminal pause failed", { terminal_id: terminalId, error: errorName(err) });
            }
        }
        logger.info("Terminals suspended until the dashboard is back", { count: this.dependencies.registry.size() });
    }

    /**
     * `welcome` arrived. Every shell the dashboard did not close is read again, except one whose
     * window is still full. That one resumes on the `ack` that reopens it.
     */
    resumeAll(): void {
        if (!this.suspended) return;
        this.suspended = false;
        for (const [terminalId, session] of this.dependencies.registry.entries()) {
            const stream = this.streams.get(terminalId);
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
        const openedAtMillis = this.nowMillis();
        const stream: TerminalStream = {
            session,
            window: new FlowWindow(windowBytes),
            splitter: new FrameSplitter((chunk) => this.sendData(terminalId, chunk), bundleBytes),
            paused: false,
            sentSeq: 0,
            heldBundles: [],
            openedAtMillis,
            lastActivityMillis: openedAtMillis,
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
            this.forgetStream(terminalId);

            logger.info("Terminal shell exited", { terminal_id: terminalId, exit_code: exitCode, signal });
            const exit: TerminalExit = signal
                ? { terminal_id: terminalId, exit_code: null, signal: signalName(signal) }
                : { terminal_id: terminalId, exit_code: exitCode, signal: null };
            this.dependencies.send(event(CHANNEL_TERMINAL, OP_EXIT, exit));
            this.dependencies.send(event(CHANNEL_TERMINAL, OP_CLOSE,
                { terminal_id: terminalId, reason: CLOSE_REASON_USER_CLOSED }));
        });
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
     */
    private sendData(terminalId: string, chunk: Buffer): void {
        const stream = this.streams.get(terminalId);
        if (!stream) return;
        if (this.suspended) {
            stream.heldBundles.push(chunk);
            return;
        }

        stream.sentSeq += 1;
        const data: TerminalData = { terminal_id: terminalId, data: chunk.toString("base64") };
        this.dependencies.send({ ...event(CHANNEL_TERMINAL, OP_DATA, data), seq: stream.sentSeq });
        stream.window.recordSent(chunk.length);

        if (!stream.window.isOpen() && !stream.paused) {
            stream.paused = true;
            stream.session.pause();
            logger.debug("Terminal window full, reads paused", { terminal_id: terminalId });
        }
    }

    private acknowledge(envelope: Envelope): void {
        const parsed = TerminalAckSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const stream = this.streams.get(parsed.data.terminal_id);
        if (!stream) return;

        stream.window.recordAck(parsed.data.ack_bytes);
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

    /** A shell is gone. The context poll stops with the last one, so an idle agent spawns nothing. */
    private forgetStream(terminalId: string): void {
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
        if (this.expiryTimer || (this.idleTimeoutMillis === undefined && this.maxSessionMillis === undefined)) {
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
