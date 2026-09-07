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
 * Returns the path to the daemon config file (daemon-config.json).
 * Holds settings that must survive a clean shutdown (e.g. log level), unlike
 * daemon-state.json which is per-run crash-recovery state.
 */
export function getDaemonConfigPath(): string {
    return path.join(getPinggyConfigDir(), "daemon-config.json");
}

/**
 * Returns the OS-conventional log directory for the Pinggy CLI.
 * Uses a "Pinggy-CLI" namespace
 * - Linux: $XDG_STATE_HOME/pinggy-cli/logs (default ~/.local/state/pinggy-cli/logs)
 * - macOS: ~/Library/Logs/Pinggy-CLI
 * - Windows: %LOCALAPPDATA%/Pinggy-CLI/Logs
 */
export function getPinggyLogDir(): string {
    const platform = os.platform();
    if (platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return path.join(localAppData, "Pinggy-CLI", "Logs");
    }
    if (platform === "darwin") {
        return path.join(os.homedir(), "Library", "Logs", "Pinggy-CLI");
    }
    // Linux / other
    const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    return path.join(stateHome, "pinggy-cli", "logs");
}

export function ensurePinggyLogDir(): string {
    const dir = getPinggyLogDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getTunnelLogDir(): string {
    return path.join(getPinggyLogDir(), "tunnels");
}

export function ensureTunnelLogDir(): string {
    const dir = getTunnelLogDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getLibpinggyLogDir(): string {
    return path.join(getPinggyLogDir(), "libpinggy");
}

export function ensureLibpinggyLogDir(): string {
    const dir = getLibpinggyLogDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getLibpinggyLogPath(): string {
    return path.join(getLibpinggyLogDir(), "libpinggy.log");
}

/**
 * Returns the log file path for a tunnel.
 * Named tunnels: <origin>__<name>.log  (stable across restarts)
 * Ad-hoc tunnels: <origin>__<tunnelId>.log
 * Origin is one of: "app" | "cli" | "remote".
 */
export function getTunnelLogPath(tunnelId: string, origin: string, name?: string): string {
    const dir = getTunnelLogDir();
    if (name) {
        const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(dir, `${origin}__${sanitized}.log`);
    }
    return path.join(dir, `${origin}__${tunnelId}.log`);
}

/**
 * Returns the path to the daemon log file.
 */
export function getDaemonLogPath(): string {
    return path.join(getPinggyLogDir(), "daemon.log");
}

/**
 * Ensures the base pinggy config directory exists.
 * Returns the path of the device agent identity file.
 *
 * Sibling of the tunnels directory, not inside it: a device agent is not a tunnel config, and the
 * file holds a live credential.
 */
export function getDeviceConfigPath(): string {
    return path.join(getPinggyConfigDir(), "device.json");
}

/**
 * Ensures the base config directory exists.
 */
export function ensurePinggyConfigDir(): string {
    const dir = getPinggyConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
