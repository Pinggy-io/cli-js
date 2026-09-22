import { z } from "zod";

/**
 * Frames and payloads for the `terminal` channel.
 *
 * The terminal id rides in every payload as `terminal_id`, never in the envelope's `id`, which keeps
 * doing exactly what it does on every other channel. See
 * docs/pinggy-devices/api-websocket-terminal.md in the pinggy_backend repo.
 *
 * Slice T1 knows 3 ops: `open` in, `opened` out, and `close` both ways. Slice T1b adds `resize` in,
 * sent when the tabs watching a shell change size, and the shells held across a reconnect, listed
 * in `hello`. No shell byte crosses this channel yet.
 */
export const CHANNEL_TERMINAL = "terminal";

export const OP_OPEN = "open";
export const OP_OPENED = "opened";
export const OP_CLOSE = "close";
export const OP_RESIZE = "resize";

export const MIN_GRID = 1;
export const MAX_GRID = 1000;

/** The subset of the 10 close reasons the agent sends in T1. */
export const CLOSE_REASON_USER_CLOSED = "user_closed";
export const CLOSE_REASON_ERROR = "error";

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

export type TerminalOpen = z.infer<typeof TerminalOpenSchema>;
export type TerminalClose = z.infer<typeof TerminalCloseSchema>;

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