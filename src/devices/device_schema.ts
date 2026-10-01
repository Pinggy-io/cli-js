import { z } from "zod";
import type { TerminalHeld } from "./terminal/terminal_schema.js";
import type { TunnelConfigV1 } from "../remote_management/remote_schema.js";

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
    // Optional: a dashboard that predates terminals sends none of these.
    terminal_enabled: z.boolean().optional(),
    max_terminals_per_device: z.number().optional(),
    // No default on the agent. Without it, terminals stay unavailable rather than unbraked.
    terminal_window_bytes: z.number().optional(),
    // No default either. Without them the agent runs no expiry timers, and the dashboard's sweep
    // still ends an expired shell, only later.
    terminal_idle_timeout_seconds: z.number().optional(),
    terminal_max_session_seconds: z.number().optional(),
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

/** 1 forwarding rule of a tunnel. The type and the local address, nothing else. */
export interface DeviceTunnelForwarding {
    type: string;
    local_address: string;
}

/**
 * 1 tunnel the daemon holds. `forwarding` stays the type-and-local-address-only summary the tab strip
 * and the running/stopped rows read; `tunnel_config` (decided 2026-09-30, see `decisions.md`) is the
 * full config the tunnel was started with, token and every credential included, for the Info modal.
 * Null when the daemon's answer for this tunnel does not parse as a config, which an unrelated
 * daemon change would cause; every other field above still renders.
 */
export interface DeviceTunnel {
    tunnel_id: string;
    config_id: string | null;
    name: string | null;
    /** `idle`, `starting`, `running`, `live`, `closed`, `exited`. */
    state: string;
    error_message: string | null;
    remote_urls: string[];
    forwarding: DeviceTunnelForwarding[];
    /** `foreground` or `detached`. Null from a daemon that does not report it. */
    mode: string | null;
    created_at: number | null;
    started_at: number | null;
    tunnel_config: TunnelConfigV1 | null;
}

/**
 * 1 config saved with `pinggy config save`. `tunnel_config` is the full saved config, the same one
 * `pinggy start` would send to the daemon, token and every credential included.
 */
export interface DeviceSavedTunnelConfig {
    config_id: string;
    name: string;
    /** A listed tunnel carries this config id and is not closed or exited. */
    running: boolean;
    tunnel_config: TunnelConfigV1;
}

/** `device/tunnels`. Sent after welcome, then only when it changed. */
export interface DeviceTunnelList {
    daemon_running: boolean;
    /** Why `daemon_running` is false, when known: `ipc_version_mismatch`, `daemon_unreachable`. */
    daemon_unavailable_reason: string | null;
    tunnels: DeviceTunnel[];
    saved_configs: DeviceSavedTunnelConfig[];
    truncated: boolean;
    collected_at: number;
}

/**
 * `tunnel/start`, `tunnel/stop`, `tunnel/restart` from the dashboard (slice 10). 1 of 3 shapes:
 * `tunnel_id`; `source: "device"` with `config_id`; `source: "dashboard"` with `config`, which holds
 * a token and is never logged. Which shape is valid for which op is checked by the handler.
 */
export const TunnelActionSchema = z.object({
    tunnel_id: z.string().min(1).max(128).optional(),
    source: z.enum(["device", "dashboard"]).optional(),
    config_id: z.string().min(1).max(128).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
});

export type TunnelAction = z.infer<typeof TunnelActionSchema>;

/** The answer when the daemon accepted the action. The row itself updates from the next `device/tunnels`. */
export interface TunnelActionAnswer {
    tunnel_id: string;
    state: string;
}
