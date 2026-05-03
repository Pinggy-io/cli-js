import os from "os";
import path from "path";
import fs from "fs";

/**
 * Returns the base Pinggy config directory for the current platform.
 * - Linux/macOS: $XDG_CONFIG_HOME/pinggy or ~/.config/pinggy
 * - Windows: %APPDATA%/pinggy
 */
export function getPinggyConfigDir(): string {
    const platform = os.platform();

    let baseDir: string;
    if (platform === "win32") {
        baseDir = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    } else {
        baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    }

    return path.join(baseDir, "pinggy");
}

/**
 * Returns the directory where tunnel config files are stored.
 */
export function getTunnelConfigDir(): string {
    return path.join(getPinggyConfigDir(), "tunnels");
}

/**
 * Ensures the tunnel config directory exists, creating it recursively if needed.
 */
export function ensureTunnelConfigDir(): string {
    const dir = getTunnelConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Returns the path to the daemon info file (daemon.json).
 * Contains port + PID so the foreground CLI can find the running daemon.
 */
export function getDaemonInfoPath(): string {
    return path.join(getPinggyConfigDir(), "daemon.json");
}

/**
 * Returns the path to the daemon log file.
 */
export function getDaemonLogPath(): string {
    return path.join(getPinggyConfigDir(), "daemon.log");
}

/**
 * Ensures the base pinggy config directory exists.
 */
export function ensurePinggyConfigDir(): string {
    const dir = getPinggyConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
