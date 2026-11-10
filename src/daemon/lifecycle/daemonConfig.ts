/**
 * Daemon configuration persisted across clean shutdowns.
 * Separate from daemon-state.json (which is per-run crash-recovery state and
 * is deleted on graceful shutdown) so settings like the chosen log level
 * survive a daemon restart.
 */
import fs from "node:fs";
import { ensurePinggyConfigDir, getDaemonConfigPath } from "../../utils/configDir.js";
import type { TunnelOrigin } from "../../tunnel_manager/TunnelManager.js";

export type LogLevelName = "debug" | "info" | "error";

/** The background device agent. Its token and server stay in device.json. */
export interface SavedDeviceAgent {
    startedAt: string;
    startedBy: TunnelOrigin;
}

export interface DaemonConfig {
    logLevel?: LogLevelName;
    deviceAgent?: SavedDeviceAgent;
}

export function readDaemonConfig(): DaemonConfig | null {
    try {
        const p = getDaemonConfigPath();
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as DaemonConfig;
        if (typeof parsed !== "object" || parsed === null) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * The level a daemon starts with. The persisted level wins over PINGGY_LOG_LEVEL, so
 * `pinggy log level <x>` survives a daemon restart.
 */
export function configuredLogLevel(): LogLevelName {
    return readDaemonConfig()?.logLevel ?? (process.env.PINGGY_LOG_LEVEL as LogLevelName | undefined) ?? "info";
}

export function savedDeviceAgent(): SavedDeviceAgent | null {
    return readDaemonConfig()?.deviceAgent ?? null;
}

export function saveDeviceAgent(startedBy: TunnelOrigin): void {
    writeDaemonConfig({ deviceAgent: { startedAt: new Date().toISOString(), startedBy } });
}

export function forgetDeviceAgent(): void {
    if (!savedDeviceAgent()) return;
    // JSON.stringify leaves out an undefined field, so the merge deletes it.
    writeDaemonConfig({ deviceAgent: undefined });
}

export function writeDaemonConfig(partial: Partial<DaemonConfig>): void {
    try {
        ensurePinggyConfigDir();
        const current = readDaemonConfig() ?? {};
        const next: DaemonConfig = { ...current, ...partial };
        const p = getDaemonConfigPath();
        const tmp = p + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
        fs.renameSync(tmp, p);
    } catch {
        // Best-effort. Persistence failure should not break the daemon.
    }
}
