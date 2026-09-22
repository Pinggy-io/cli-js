import { z } from "zod";
import type { TerminalHeld } from "./terminal/terminal_schema.js";

/**
 * Payload schemas for the device agent channel.
 *
 * zod strips unknown keys by default, and that is load-bearing: the dashboard can add fields to
 * welcome later and an older agent keeps working. Do not make these strict.
 */
export const WelcomeSchema = z.object({
    device_agent_id: z.string(),
    accepted_proto: z.number(),
    heartbeat_interval_seconds: z.number(),
    stats_interval_seconds: z.number(),
    server_time: z.number(),
    max_frame_bytes: z.number(),
    // Optional: a dashboard that predates terminals sends neither.
    terminal_enabled: z.boolean().optional(),
    max_terminals_per_device: z.number().optional(),
});

export const ErrorPayloadSchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
    }),
});

export const DisconnectSchema = z.object({
    reason: z.string(),
});

export type Welcome = z.infer<typeof WelcomeSchema>;
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export interface Hello {
    agent_version: string;
    os: string;
    hostname: string;
    capabilities: string[];
    /** The shells still running from before this connection. Empty on a fresh start. */
    terminals: TerminalHeld[];
}

export interface Heartbeat {
    uptime_seconds: number;
}

/** `device/info`. Static facts, sent once right after welcome. */
export interface DeviceInfo {
    hostname: string;
    os: string;
    os_version: string;
    arch: string;
    kernel: string;
    cpu_model: string;
    cpu_cores: number;
    total_memory_bytes: number;
}

/** `device/metrics`. Every field is always present, on every platform. */
export interface DeviceMetrics {
    cpu_percent: number;
    load_avg_1m: number;
    load_avg_5m: number;
    load_avg_15m: number;
    memory_used_bytes: number;
    memory_total_bytes: number;
    uptime_seconds: number;
    collected_at: number;
}
