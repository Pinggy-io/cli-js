import { logger } from "../../logger.js";
import { Envelope, event, response } from "../envelope.js";
import {
    CHANNEL_TERMINAL, CLOSE_REASON_USER_CLOSED, ERROR_INVALID_PAYLOAD, ERROR_SHELL_NOT_ALLOWED, ERROR_SPAWN_FAILED,
    ERROR_TERMINAL_DISABLED, ERROR_TERMINAL_LIMIT_REACHED, OP_CLOSE, OP_OPEN, OP_OPENED, OP_RESIZE, TerminalCloseSchema,
    TerminalHeld, TerminalOpenRefused, TerminalOpenSchema, TerminalOpened, TerminalResizeSchema, clampGrid,
} from "./terminal_schema.js";
import { TerminalRegistry } from "./terminalRegistry.js";
import { PtySession, PtySpawnRequest } from "./ptySession.js";
import { ShellResolution } from "./shellAllowlist.js";

/**
 * The agent's half of the `terminal` channel. 1 per agent run, not per socket: **a shell outlives the
 * connection that opened it.**
 *
 * `open` spawns a shell and answers `opened` with its pid. `close` from the dashboard kills it.
 * `resize` sets the grid the watching tabs share. A shell that exits on its own sends `close` up. An
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
 * **No log line here carries a payload.** Ids, pids and error codes only. From T2 on, payloads on this
 * channel are what a person types, and the log line that leaks a password is the one written before
 * that day.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalHandlerDependencies {
    send: (frame: Envelope) => void;
    spawn: (request: PtySpawnRequest) => PtySession;
    resolveShell: (requested: string | null | undefined) => ShellResolution;
    registry: TerminalRegistry<PtySession>;
}

export class TerminalHandler {
    private enabled = true;
    private suspended = false;

    constructor(private readonly dependencies: TerminalHandlerDependencies) {
    }

    /** From welcome. An older dashboard sends neither field, and the defaults hold. */
    configure(terminalEnabled: boolean | undefined, maxTerminalsPerDevice: number | undefined): void {
        if (terminalEnabled !== undefined) this.enabled = terminalEnabled;
        if (maxTerminalsPerDevice !== undefined) this.dependencies.registry.setMaxTerminals(maxTerminalsPerDevice);
    }

    handle(envelope: Envelope): void {
        if (envelope.op === OP_OPEN) {
            this.open(envelope);
        } else if (envelope.op === OP_CLOSE) {
            this.closeFromDashboard(envelope);
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

    /** `welcome` arrived. Every shell the dashboard did not close is read again. */
    resumeAll(): void {
        if (!this.suspended) return;
        this.suspended = false;
        for (const [terminalId, session] of this.dependencies.registry.entries()) {
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

        if (!this.enabled) {
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

        const terminalId = request.terminal_id;
        session.onExit((exitCode, signal) => {
            // Only when this exit was not asked for. A close from the dashboard removes first.
            if (registry.remove(terminalId) === undefined) return;
            logger.info("Terminal shell exited", { terminal_id: terminalId, exit_code: exitCode, signal });
            this.dependencies.send(event(CHANNEL_TERMINAL, OP_CLOSE,
                { terminal_id: terminalId, reason: CLOSE_REASON_USER_CLOSED }));
        });

        logger.info("Terminal opened", { terminal_id: terminalId, pid: session.pid });
        const opened: TerminalOpened = { terminal_id: terminalId, pid: session.pid, shell: session.shell, cols, rows };
        this.dependencies.send(response(envelope, OP_OPENED, opened));
    }

    private closeFromDashboard(envelope: Envelope): void {
        const parsed = TerminalCloseSchema.safeParse(envelope.payload);
        if (!parsed.success) return;
        const session = this.dependencies.registry.remove(parsed.data.terminal_id);
        if (!session) return;
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