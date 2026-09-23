import { z } from "zod";

/**
 * Frames and payloads for the `terminal` channel.
 *
 * The terminal id rides in every payload as `terminal_id`, never in the envelope's `id`, which keeps
 * doing exactly what it does on every other channel. See
 * docs/pinggy-devices/api-websocket-terminal.md in the pinggy_backend repo.
 *
 * 8 ops: `open` in, `opened` out, `data` both ways, `ack` in, `exit` out, `resize` in, `signal` in,
 * and `close` both ways. `data` carries base64 because the envelope is JSON, which keeps the bytes
 * opaque to every hop in between. Out it is shell output (slice T2), in it is keystrokes (slice T3).
 * `resize` (slice T1b) is sent when the tabs watching a shell change size. The shells held across a
 * reconnect are listed in `hello`.
 */
export const CHANNEL_TERMINAL = "terminal";

export const OP_OPEN = "open";
export const OP_OPENED = "opened";
export const OP_CLOSE = "close";
export const OP_DATA = "data";
export const OP_ACK = "ack";
export const OP_EXIT = "exit";
export const OP_RESIZE = "resize";
export const OP_SIGNAL = "signal";

/**
 * The signals a browser may send to the foreground process group. `KILL` is left out on purpose: it
 * cannot be caught, so nothing cleans up and no real exit code comes back. Close ends a shell
 * properly. Ctrl-C and Ctrl-\ arrive as `data`, not here.
 */
export const TERMINAL_SIGNALS = ["INT", "TERM", "QUIT", "HUP"] as const;

export const MIN_GRID = 1;
export const MAX_GRID = 1000;

/** The subset of the 10 close reasons the agent sends. The last 2 since slice T4. */
export const CLOSE_REASON_USER_CLOSED = "user_closed";
export const CLOSE_REASON_ERROR = "error";
export const CLOSE_REASON_IDLE_TIMEOUT = "idle_timeout";
export const CLOSE_REASON_MAX_SESSION = "max_session";

/** Refusal codes the agent answers `open` with, beside `terminal_id`. */
export const ERROR_INVALID_PAYLOAD = "invalid_payload";
export const ERROR_TERMINAL_LIMIT_REACHED = "terminal_limit_reached";
export const ERROR_TERMINAL_DISABLED = "terminal_disabled";
export const ERROR_SHELL_NOT_ALLOWED = "shell_not_allowed";
export const ERROR_SPAWN_FAILED = "spawn_failed";

/** Not strict, for the same reason as the device schemas: the dashboard can add fields. */
export const TerminalOpenSchema = z.object({
    terminal_id: z.string().min(1),
    cols: z.number().int().optional(),
    rows: z.number().int().optional(),
    shell: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
});

export const TerminalCloseSchema = z.object({
    terminal_id: z.string().min(1),
    reason: z.string().optional(),
});

export const TerminalResizeSchema = z.object({
    terminal_id: z.string().min(1),
    cols: z.number().int(),
    rows: z.number().int(),
});

/** `terminal/data` in: keystrokes, base64. */
export const TerminalInputSchema = z.object({
    terminal_id: z.string().min(1),
    data: z.string(),
});

/** Anything outside the allowlist fails to parse, so it never reaches the pty. */
export const TerminalSignalSchema = z.object({
    terminal_id: z.string().min(1),
    signal: z.enum(TERMINAL_SIGNALS),
});

/**
 * Cumulative totals, never increments, so a dropped ack self-heals on the next one.
 *
 * `ack_bytes` is what the browser has actually drawn, counted in raw bytes. It is not trusted: the
 * window clamps it to what was sent.
 */
export const TerminalAckSchema = z.object({
    terminal_id: z.string().min(1),
    ack_seq: z.number().optional(),
    ack_bytes: z.number(),
});

export type TerminalOpen = z.infer<typeof TerminalOpenSchema>;
export type TerminalClose = z.infer<typeof TerminalCloseSchema>;
export type TerminalAck = z.infer<typeof TerminalAckSchema>;

/** `terminal/data`: raw pty bytes, base64 encoded. Nothing between the halves decodes them. */
export interface TerminalData {
    terminal_id: string;
    data: string;
}

/** `terminal/exit`: the process ended. A null `exit_code` means a signal killed it, named in `signal`. */
export interface TerminalExit {
    terminal_id: string;
    exit_code: number | null;
    signal: string | null;
}

/** `terminal/opened`: what actually spawned, which may differ from what was asked for. */
export interface TerminalOpened {
    terminal_id: string;
    pid: number;
    shell: string;
    cols: number;
    rows: number;
}

/** 1 shell this agent still holds, listed in `hello` so the dashboard can keep it across a reconnect. */
export interface TerminalHeld {
    terminal_id: string;
    pid: number;
    shell: string;
    cols: number;
    rows: number;
}

export interface TerminalOpenRefused {
    terminal_id: string | null;
    error: { code: string; message: string };
}

export function clampGrid(requested: number | undefined, fallback: number): number {
    if (requested === undefined || !Number.isFinite(requested)) return fallback;
    return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.trunc(requested)));
}