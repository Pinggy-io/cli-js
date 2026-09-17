import { logger } from "../../logger.js";
import { Envelope, event, response } from "../envelope.js";
import {
    CHANNEL_TERMINAL, CLOSE_REASON_USER_CLOSED, ERROR_INVALID_PAYLOAD, ERROR_SHELL_NOT_ALLOWED, ERROR_SPAWN_FAILED,
    ERROR_TERMINAL_DISABLED, ERROR_TERMINAL_LIMIT_REACHED, OP_CLOSE, OP_OPEN, OP_OPENED, TerminalCloseSchema,
    TerminalOpenRefused, TerminalOpenSchema, TerminalOpened, clampGrid,
} from "./terminal_schema.js";
import { TerminalRegistry } from "./terminalRegistry.js";
import { PtySession, PtySpawnRequest } from "./ptySession.js";
import { ShellResolution } from "./shellAllowlist.js";

/**
 * The agent's half of the `terminal` channel, for 1 socket.
 *
 * `open` spawns a shell and answers `opened` with its pid. `close` from the dashboard kills it. A
 * shell that exits on its own sends `close` up. Nothing else is handled in slice T1, and an unknown
 * op is ignored, never fatal.
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
        } else {
            logger.debug("Ignoring unhandled terminal op", { op: envelope.op });
        }
    }

    /** The socket is gone. Every shell dies with it; the dashboard has already recorded device_gone. */
    closeAll(): void {
        this.dependencies.registry.killAll();
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