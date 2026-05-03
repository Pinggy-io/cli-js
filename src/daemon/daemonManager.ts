/**
 * Daemon lifecycle management.
 * Handles spawning, stopping, status checking, and stale PID cleanup.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { getDaemonInfoPath } from "../utils/configDir.js";
import { DaemonInfo } from "./daemonChild.js";
import { logger } from "../logger.js";

const DAEMON_SPAWN_TIMEOUT_MS = 8000;
const DAEMON_POLL_INTERVAL_MS = 200;

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0); // Signal 0: doesn't kill, just checks
        return true;
    } catch {
        return false;
    }
}

/**
 * Read and validate daemon.json.
 * Returns null if file doesn't exist, is malformed, or PID is stale.
 * Automatically cleans up stale daemon.json.
 */
export function getDaemonInfo(): DaemonInfo | null {
    const infoPath = getDaemonInfoPath();
    if (!fs.existsSync(infoPath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(infoPath, "utf-8")) as DaemonInfo;
        if (!data.pid || !data.port) return null;

        // Validate PID is still alive
        if (!isProcessAlive(data.pid)) {
            logger.info("Stale daemon.json found, cleaning up", { stalePid: data.pid });
            try { fs.unlinkSync(infoPath); } catch { /* best effort */ }
            return null;
        }

        return data;
    } catch {
        return null;
    }
}

/**
 * Check if the daemon is currently running.
 */
export function isDaemonRunning(): boolean {
    return getDaemonInfo() !== null;
}

/**
 * Resolve the command + args needed to re-spawn the current process as a daemon child.
 * Handles both:
 *   - npm/node: process.argv[0] = node, process.argv[1] = script
 *   - pkg binary: process.execPath = binary, no script arg needed
 */
function getDaemonSpawnArgs(): { command: string; args: string[] } {
    const isPkg = !!(process as any).pkg;

    if (isPkg) {
        // pkg binary: execPath IS the binary
        return {
            command: process.execPath,
            args: ["--_daemon-child"],
        };
    }

    // node process: execPath = node, argv[1] = script entry
    return {
        command: process.execPath,
        args: [process.argv[1], "--_daemon-child"],
    };
}

/**
 * Start the daemon by forking a detached child process.
 * Waits for daemon.json to appear (confirms the child is ready).
 */
export async function startDaemon(): Promise<DaemonInfo> {
    // Check if already running
    const existing = getDaemonInfo();
    if (existing) {
        return existing;
    }

    const { command, args } = getDaemonSpawnArgs();
    logger.info("Spawning daemon child", { command, args });

    const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
    });

    child.unref();

    // Wait for daemon.json to appear (child writes it after IPC server binds)
    const info = await pollForDaemonInfo(DAEMON_SPAWN_TIMEOUT_MS);
    if (!info) {
        throw new Error("Daemon failed to start within timeout. Check daemon.log for details.");
    }

    return info;
}

/**
 * Poll for daemon.json to appear on disk.
 */
function pollForDaemonInfo(timeoutMs: number): Promise<DaemonInfo | null> {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            const info = getDaemonInfo();
            if (info) {
                resolve(info);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                resolve(null);
                return;
            }
            setTimeout(check, DAEMON_POLL_INTERVAL_MS);
        };
        check();
    });
}

/**
 * Stop the running daemon via HTTP /shutdown endpoint.
 * Falls back to SIGTERM if HTTP fails.
 */
export async function stopDaemon(): Promise<boolean> {
    const info = getDaemonInfo();
    if (!info) return false;

    try {
        // Try HTTP shutdown first (works on all platforms including Windows)
        const { IPCClient } = await import("./ipcClient.js");
        const client = new IPCClient(info.port);
        await client.shutdown();
        return true;
    } catch {
        // Fallback: send SIGTERM (doesn't work on Windows)
        try {
            process.kill(info.pid, "SIGTERM");
            return true;
        } catch {
            return false;
        }
    }
}
