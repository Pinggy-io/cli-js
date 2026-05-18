/**
 * Daemon lifecycle management.
 * Handles spawning, stopping, status checking, and stale PID cleanup.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getDaemonInfoPath, getDaemonLogPath } from "../utils/configDir.js";
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
 * Resolve the cli-js entry file when running inside Electron. argv[1] points at
 * the host app's main bundle, not at us, so we resolve our own package main.
 */
function resolveElectronDaemonEntry(): string {
    try {
        const req = createRequire(import.meta.url);
        return req.resolve("pinggy");
    } catch {
        // Fallback: a sibling of this module inside dist/.
        const here = fileURLToPath(import.meta.url);
        return path.join(path.dirname(here), "index.cjs");
    }
}

/**
 * Resolve the command + args needed to re-spawn the current process as a daemon child.
 * Works for npm/node (argv[1] = script), pkg binary (argv[1] = snapshot entrypoint),
 * and Electron host (execPath is Electron, argv[1] is the app's main bundle).
 */
function getDaemonSpawnArgs(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    if (process.versions.electron) {
        const entry = resolveElectronDaemonEntry();
        return {
            command: process.execPath,
            args: [entry, "--_daemon-child"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        };
    }
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
    logger.info("Spawning daemon child", { command, args, electron: !!process.versions.electron });

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
 * Stop the running daemon via HTTP /shutdown. Surfaces any failures from the
 * daemon's cleanup steps and any failure to exit.
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
