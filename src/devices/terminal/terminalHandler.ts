import os from "os";
import { logger } from "../../logger.js";
import { Envelope, event, response } from "../envelope.js";
import {
    CHANNEL_TERMINAL, CLOSE_REASON_USER_CLOSED, ERROR_INVALID_PAYLOAD, ERROR_SHELL_NOT_ALLOWED, ERROR_SPAWN_FAILED,
    ERROR_TERMINAL_DISABLED, ERROR_TERMINAL_LIMIT_REACHED, OP_ACK, OP_CLOSE, OP_DATA, OP_EXIT, OP_OPEN, OP_OPENED,
    OP_RESIZE, TerminalAckSchema, TerminalCloseSchema, TerminalData, TerminalExit, TerminalHeld, TerminalOpenRefused,
    TerminalOpenSchema, TerminalOpened, TerminalResizeSchema, clampGrid,
} from "./terminal_schema.js";
import { TerminalRegistry } from "./terminalRegistry.js";
import { PtySession, PtySpawnRequest } from "./ptySession.js";
import { ShellResolution } from "./shellAllowlist.js";
import { FlowWindow } from "./flowWindow.js";
import { FrameSplitter, rawBundleBytes } from "./frameSplitter.js";

/**
 * The agent's half of the `terminal` channel. 1 per agent run, not per socket: **a shell outlives the
 * connection that opened it.**
 *
 * `open` spawns a shell and answers `opened` with its pid. Its output flows up as `data`, the
 * browser acknowledges what it has drawn with `ack`, and when the window fills the agent **stops
 * reading the pty** rather than buffering. `close` from the dashboard kills the shell. `resize` sets
 * the grid the watching tabs share. A shell that exits on its own sends `exit` and then `close`. An
 * unknown op is ignored, never fatal.
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
 * **No log line here carries a payload.** Ids, pids, byte counts and error codes only. Payloads on
 * this channel are what a person types, and the log line that leaks a password is the one written
 * before that day.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalHandlerDependencies {
    send: (frame: Envelope) => void;
    spawn: (request: PtySpawnRequest) => PtySession;
    resolveShell: (requested: string | null | undefined) => ShellResolution;
    registry: TerminalRegistry<PtySession>;
}

/** What 1 open terminal needs beyond its shell: a brake and a bundler. */
interface TerminalStream {
    readonly session: PtySession;
    readonly window: FlowWindow;
    readonly splitter: FrameSplitter;
    paused: boolean;
}

export class TerminalHandler {
    private enabled = true;
    private suspended = false;
    private windowBytes: number | undefined;
    private bundleBytes: number | undefined;
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
              terminalWindowBytes: number | undefined, maxFrameBytes: number): void {
        if (terminalEnabled !== undefined) this.enabled = terminalEnabled;
        if (maxTerminalsPerDevice !== undefined) this.dependencies.registry.setMaxTerminals(maxTerminalsPerDevice);
        this.windowBytes = terminalWindowBytes;
        this.bundleBytes = rawBundleBytes(maxFrameBytes);
        if (terminalWindowBytes === undefined) {
            logger.info("Terminals unavailable: welcome carried no terminal_window_bytes");
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
        } else {
            logger.debug("Ignoring unhandled terminal op", { op: envelope.op });
        }
    }

    /**
     * The agent is stopping: interrupted, revoked, or refused for good. Every shell dies with it.
     * A dropped socket is not this; it is `suspend`.
     */
    closeAll(): void {
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
            if (this.streams.get(terminalId)?.paused) continue;
            try {
                session.resume();
            } catch (err) {
                logger.warn("Terminal resume failed", { terminal_id: terminalId, error: errorName(err) });
            }
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
            paused: false,
        };
        this.streams.set(terminalId, stream);

        session.onData((chunk) => stream.splitter.push(chunk));

        session.onExit((exitCode, signal) => {
            // Only when this exit was not asked for. A close from the dashboard removes first.
            if (this.dependencies.registry.remove(terminalId) === undefined) return;
            // Whatever the shell printed on its way out was read before it died, and is still held.
            stream.splitter.flush();
            stream.splitter.dispose();
            this.streams.delete(terminalId);

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
     */
    private sendData(terminalId: string, chunk: Buffer): void {
        const stream = this.streams.get(terminalId);
        if (!stream) return;

        const data: TerminalData = { terminal_id: terminalId, data: chunk.toString("base64") };
        this.dependencies.send(event(CHANNEL_TERMINAL, OP_DATA, data));
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
        this.streams.delete(parsed.data.terminal_id);
        stream?.splitter.dispose();
        logger.info("Terminal closed by the dashboard", { terminal_id: parsed.data.terminal_id, pid: session.pid });
        try {
            session.kill();
        } catch {
            // Already exited.
        }
    }

    /** The tabs watching this shell changed size. Clamped like `open`, and a gone shell is ignored. */
    private resize(envelope: Envelope): void {
        const parsed = TerminalResizeSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const session = this.dependencies.registry.get(parsed.data.terminal_id);
        if (!session) return;
        const cols = clampGrid(parsed.data.cols, session.cols);
        const rows = clampGrid(parsed.data.rows, session.rows);
        try {
            session.resize(cols, rows);
        } catch (err) {
            // Exited between the lookup and the call.
            logger.debug("Terminal resize failed", { terminal_id: parsed.data.terminal_id, error: errorName(err) });
        }
    }

    private refuse(envelope: Envelope, terminalId: string | null, code: string, message: string): void {
        logger.info("Terminal open refused", { terminal_id: terminalId, code });
        const refused: TerminalOpenRefused = { terminal_id: terminalId, error: { code, message } };
        this.dependencies.send(response(envelope, OP_OPENED, refused));
    }
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
