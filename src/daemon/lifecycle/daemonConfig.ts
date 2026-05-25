/**
 * Daemon configuration persisted across clean shutdowns.
 * Separate from daemon-state.json (which is per-run crash-recovery state and
 * is deleted on graceful shutdown) so settings like the chosen log level
 * survive a daemon restart.
 */
import fs from "node:fs";
import { ensurePinggyConfigDir, getDaemonConfigPath } from "../../utils/configDir.js";

export type LogLevelName = "debug" | "info" | "error";

export interface DaemonConfig {
    logLevel?: LogLevelName;
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
