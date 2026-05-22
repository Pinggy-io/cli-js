/**
 * Daemon lifecycle management.
 * Handles spawning, stopping, status checking, and stale PID cleanup.
 */
import os from "node:os";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { getDaemonInfoPath, getDaemonLogPath } from "../utils/configDir.js";
import { DaemonInfo, DaemonHandle } from "./daemonChild.js";
import { logger } from "../logger.js";

let inProcessHandle: DaemonHandle | null = null;

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

function getDaemonSpawnArgs(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    return {
        command: process.execPath,
        args: [process.argv[1], "--_daemon-child"],
        env: { ...process.env },
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

    const { command, args, env } = getDaemonSpawnArgs();
    logger.info("Spawning daemon child", { command, args });

     if (os.platform() === "win32") {

        let stderrOutput = "";
        let exited = false;
        let exitCode: number | null = null;

        const child = spawn(command, args, {
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
            env,
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            stderrOutput += chunk.toString("utf-8");
        });

        child.on("exit", (code) => {
            exited = true;
            exitCode = code;
        });

        child.unref();

        const info = await pollForDaemonInfo(DAEMON_SPAWN_TIMEOUT_MS, () => exited);
        if (!info) {
            const logPath = getDaemonLogPath();
            if (exited) {
                const detail = stderrOutput.trim() || `Check ${logPath} for details.`;
                throw new Error(`Daemon child exited with code ${exitCode}. ${detail}`);
            }
            throw new Error(`Daemon failed to start within timeout. Check ${logPath} for details.`);
        }

        child.stderr?.removeAllListeners();
        child.stderr?.destroy();

        return info;
    }

    // Unix: detached + unref, with stderr capture for better error reporting
    let stderrOutput = "";
    let exited = false;
    let exitCode: number | null = null;

    const child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env,
    });

    child.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString("utf-8");
    });

    child.on("exit", (code) => {
        exited = true;
        exitCode = code;
    });

    child.unref();

    const info = await pollForDaemonInfo(DAEMON_SPAWN_TIMEOUT_MS, () => exited);
    if (!info) {
        const logPath = getDaemonLogPath();
        if (exited) {
            const detail = stderrOutput.trim() || `Check ${logPath} for details.`;
            throw new Error(`Daemon child exited with code ${exitCode}. ${detail}`);
        }
        throw new Error(`Daemon failed to start within timeout. Check ${logPath} for details.`);
    }

    // Detach stderr now that daemon is running
    child.stderr?.removeAllListeners();
    child.stderr?.destroy();

    return info;
}

/**
 * Ensure a daemon is reachable, starting one if necessary.
 *
 * - If a daemon is already recorded in daemon.json and its PID is alive, returns its info.
 * - Inside Electron (`process.versions.electron`), starts the daemon in-process via
 *   runDaemonChild(). The host retrieve the handle with
 *   getInProcessDaemonHandle() to shut it down on app quit.
 * - Otherwise, spawns a detached daemon child.
 */
export async function ensureDaemonRunning(): Promise<DaemonInfo> {
    const existing = getDaemonInfo();
    if (existing) return existing;

    if (process.versions.electron) {
        const { runDaemonChild } = await import("./daemonChild.js");
        const handle = await runDaemonChild({
            installSignalHandlers: false,
            exitOnFailure: false,
        });
        inProcessHandle = handle;
        return (
            getDaemonInfo() ?? {
                pid: handle.pid,
                port: handle.port,
                startedAt: new Date().toISOString(),
            }
        );
    }

    return startDaemon();
}

export function getInProcessDaemonHandle(): DaemonHandle | null {
    return inProcessHandle;
}

export interface ActiveTunnelSummary {
    tunnelId: string;
    name: string;
    localAddress: string;
    urls: string[];
}

/**
 * Snapshot of tunnels currently running inside the in-process daemon.
 */
export async function getActiveTunnelSummaries(): Promise<ActiveTunnelSummary[]> {
    if (!inProcessHandle) return [];

    const { TunnelManager } = await import("../tunnel_manager/TunnelManager.js");
    const manager = TunnelManager.getInstance();
    const activeIds = manager.getActiveTunnelIds();
    if (activeIds.size === 0) return [];

    const all = await manager.getAllTunnels();
    return all
        .filter(t => activeIds.has(t.tunnelid))
        .map(t => ({
            tunnelId: t.tunnelid,
            name: (t.tunnelConfig as any)?.name || t.tunnelName || t.tunnelid.slice(0, 8),
            localAddress: getLocalAddress(t.tunnelConfig),
            urls: t.remoteurls ?? [],
        }));
}

function getLocalAddress(config: any): string {
    if (!config) return "-";
    if (config.forwarding) {
        if (typeof config.forwarding === "string") return config.forwarding;
        if (Array.isArray(config.forwarding) && config.forwarding.length > 0) {
            const f = config.forwarding[0];
            if (f.address) return f.address;
            if (f.localDomain && f.localPort) return `${f.localDomain}:${f.localPort}`;
        }
    }
    if (config.localAddress) return config.localAddress;
    return "-";
}

/**
 * Poll for daemon.json to appear on disk.
 */
function pollForDaemonInfo(timeoutMs: number, hasExited?: () => boolean): Promise<DaemonInfo | null> {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            const info = getDaemonInfo();
            if (info) {
                resolve(info);
                return;
            }
            // If the child already exited, no point waiting further
            if (hasExited?.()) {
                resolve(null);
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

export type StopDaemonResult =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Stop the running daemon via HTTP /shutdown.
 */
export async function stopDaemon(): Promise<StopDaemonResult> {
    const info = getDaemonInfo();
    if (!info) return { ok: false, error: "No daemon is running." };

    let daemonErrors: string[] = [];
    try {
        const { IPCClient } = await import("./ipcClient.js");
        const client = new IPCClient(info.port);
        const result = await client.shutdown();
        if (Array.isArray(result?.errors)) daemonErrors = result.errors;
    } catch (e: any) {
        return { ok: false, error: `Failed to reach daemon shutdown endpoint: ${e?.message ?? String(e)}` };
    }

    const exited = await waitForExit(info.pid, 5000);
    if (!exited) {
        const detail = daemonErrors.length > 0 ? ` Daemon reported: ${daemonErrors.join("; ")}` : "";
        return { ok: false, error: `Daemon PID ${info.pid} did not exit within 5s.${detail}` };
    }

    if (daemonErrors.length > 0) {
        return { ok: false, error: `Daemon exited but reported errors: ${daemonErrors.join("; ")}` };
    }
    return { ok: true };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return !isProcessAlive(pid);
}
