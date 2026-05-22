import winston from "winston";
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";
import { getTunnelLogPath } from "../utils/configDir.js";

const tunnelTransports = new Map<string, winston.transports.FileTransportInstance>();

let tunnelLoggingEnabled = true;

export function setTunnelLoggingEnabled(enabled: boolean): void {
    if (tunnelLoggingEnabled === enabled) return;
    tunnelLoggingEnabled = enabled;
    if (!enabled) {
        detachAllTunnelLoggers();
    }
}

export function isTunnelLoggingEnabled(): boolean {
    return tunnelLoggingEnabled;
}

/**
 * Attach a per-tunnel File transport to the shared winston logger.
 * Call as the first action when a tunnel is created.
 * Returns a child logger pre-tagged with { tunnelId, source: "daemon" }.
 * When tunnel logging is disabled, skips the file transport and returns
 * a child logger only (callers still work, but nothing hits disk).
 */
export function attachTunnelLogger(tunnelId: string, origin: string, name?: string): winston.Logger {
    if (!tunnelLoggingEnabled) {
        return logger.child({ tunnelId, source: "daemon" });
    }
    const logPath = getTunnelLogPath(tunnelId, origin, name);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const tunnelFilter = winston.format((info) => {
        return info.tunnelId === tunnelId ? info : false;
    });

    const transport = new winston.transports.File({
        filename: logPath,
        // Per-tunnel file receives cli-js (and sdk-js, when enabled) lines
        // tagged with this tunnelId. libpinggy's own log lines bypass this
        // file entirely — they go to a shared process-global file
        // configured via pinggy_set_log_path (see ensureLibpinggyLogDir /
        // getLibpinggyLogPath in utils/configDir.ts).
        maxsize: 10 * 1024 * 1024,
        maxFiles: 3,
        format: winston.format.combine(
            tunnelFilter(),
            winston.format.timestamp(),
            winston.format.printf(({ level, message, timestamp, source, ...meta }) => {
                const srcLabel = source ? `[${source}] ` : "";
                const { tunnelId: _tid, ...rest } = meta;
                return `${timestamp} [${level}] ${srcLabel}${message}${Object.keys(rest).length ? " " + JSON.stringify(rest) : ""}`;
            })
        ),
    });

    logger.add(transport);
    tunnelTransports.set(tunnelId, transport);

    return logger.child({ tunnelId, source: "daemon" });
}

/**
 * Detach and close the per-tunnel File transport.
 * Call from stopTunnel and creation-failure cleanup paths.
 */
export function detachTunnelLogger(tunnelId: string): void {
    const transport = tunnelTransports.get(tunnelId);
    if (!transport) return;
    logger.remove(transport);
    tunnelTransports.delete(tunnelId);
    (transport as any).close?.();
}

export function detachAllTunnelLoggers(): void {
    for (const tunnelId of tunnelTransports.keys()) {
        detachTunnelLogger(tunnelId);
    }
}
