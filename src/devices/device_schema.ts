import { z } from "zod";

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
}

export interface Heartbeat {
    uptime_seconds: number;
}
