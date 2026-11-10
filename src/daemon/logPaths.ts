/**
 * Tunnel log files on disk. The daemon and the CLI both read them: the CLI when no daemon runs, so
 * `pinggy logs` and `pinggy log path` never start one.
 */
import fs from "node:fs";
import path from "node:path";
import { listSavedConfigs } from "../cli/configStore.js";
import { getTunnelLogDir } from "../utils/configDir.js";
import { TunnelOrigin } from "../tunnel_manager/TunnelManager.js";
import { ResolveLogPathResponse } from "./ipc/ipcRoutes.js";

export const TUNNEL_ORIGINS: TunnelOrigin[] = ["app", "cli", "remote", "device"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a tunnel log filename. Expected formats:
 *   <origin>__<name>.log              (saved/named tunnel)
 *   <origin>__<tunnelId>.log          (ad-hoc tunnel)
 *   <origin>__<name>__<tunnelId>.log  (legacy; pre single-file-per-name change)
 * Returns null if the filename does not start with a recognized origin.
 */
export function parseTunnelLogFilename(filename: string): { origin: TunnelOrigin; name?: string; tunnelId?: string } | null {
    const base = filename.replace(/\.log$/, "");
    const parts = base.split("__");
    if (parts.length < 2) return null;
    const origin = parts[0] as TunnelOrigin;
    if (!(TUNNEL_ORIGINS as string[]).includes(origin)) return null;
    if (parts.length === 2) {
        const second = parts[1];
        if (UUID_RE.test(second)) return { origin, tunnelId: second };
        return { origin, name: second };
    }
    // 3+ parts: legacy <origin>__<name>__<tunnelId>.log
    const tunnelId = parts[parts.length - 1];
    const name = parts.slice(1, -1).join("__");
    return { origin, name, tunnelId };
}

/** Tunnel log files, without rotated copies such as `x.log.1`. */
export function listTunnelLogFiles(): string[] {
    const logDir = getTunnelLogDir();
    if (!fs.existsSync(logDir)) return [];
    return fs.readdirSync(logDir).filter((f) => f.endsWith(".log") && !/\.log\.\d+$/.test(f));
}

function newestLogFile(q: string): ResolveLogPathResponse | null {
    const logDir = getTunnelLogDir();
    const matches: Array<{ path: string; mtime: number; tunnelId?: string; name?: string; origin: TunnelOrigin }> = [];

    for (const file of listTunnelLogFiles()) {
        const parsed = parseTunnelLogFilename(file);
        if (!parsed) continue;

        const nameMatch = parsed.name !== undefined && parsed.name === q;
        const idMatch = parsed.tunnelId !== undefined && (parsed.tunnelId === q || parsed.tunnelId.startsWith(q));

        if (nameMatch || idMatch) {
            const filePath = path.join(logDir, file);
            matches.push({ ...parsed, path: filePath, mtime: fs.statSync(filePath).mtimeMs });
        }
    }

    if (matches.length === 0) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    const best = matches[0];
    return { status: "historical", path: best.path, tunnelId: best.tunnelId, name: best.name, origin: best.origin, running: false };
}

/**
 * The log of a tunnel that is not running: its newest log file, else a saved config that has never
 * run, else not found.
 */
export function resolveStoppedLogPath(q: string): ResolveLogPathResponse {
    if (!q) return { status: "not-found" };

    const historical = newestLogFile(q);
    if (historical) return historical;

    const saved = listSavedConfigs();
    const matchedConfig = saved.find(c => c.name === q || c.configId === q || c.configId.startsWith(q));
    if (matchedConfig) {
        return { status: "config-only", name: matchedConfig.name, configId: matchedConfig.configId };
    }

    return { status: "not-found" };
}
