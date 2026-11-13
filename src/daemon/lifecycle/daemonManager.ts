/**
 * Daemon lifecycle management.
 * Handles spawning, stopping, status checking, and stale PID cleanup.
 */
import os from "node:os";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { getDaemonInfoPath, getDaemonLogPath } from "../../utils/configDir.js";
import { DaemonInfo, DaemonHandle } from "./daemonChild.js";
import { DaemonHost, IPC_VERSION, ShutdownStatus } from "../ipc/ipcRoutes.js";
import { logger } from "../../logger.js";
import { ClientOrigin } from "../ipc/ipcClient.js";
import { TunnelStateType } from "../../types.js";
import { errorMessage, getLocalAddress, getVersion } from "../../utils/util.js";
import CLIPrinter from "../../utils/printer.js";
import { readUpdateState, writeUpdateState } from "../../update/updateState.js";
import { serviceRestartInstruction } from "./serviceInstaller.js";
import { isPackagedBinary } from "../../devices/terminal/nodePtyRuntime.js";
import { unixLayoutPaths } from "../../update/installKind.js";

let inProcessHandle: DaemonHandle | null = null;

const DAEMON_SPAWN_TIMEOUT_MS = 8000;
const DAEMON_POLL_INTERVAL_MS = 200;
const SPAWN_FAILED_EXIT_CODE = -1;
const DAEMON_STOP_INSTRUCTION = '"pinggy daemon stop"';

/** os.uptime() counts whole seconds, and the clock can move. A record older than boot by more is stale. */
const BOOT_TIME_TOLERANCE_MILLIS = 60_000;

/**
 * Check if a process with the given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0); // Signal 0: doesn't kill, just checks
        return true;
    } catch (err) {
        // EPERM: the process exists, but this one may not signal it. On Windows, the service task runs
        // without admin rights and gets EPERM for a daemon started from an Administrator shell.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** A PID recorded before the last boot can name another process now. An unparseable time counts as before. */
export function startedBeforeBoot(startedAt: string): boolean {
    const startedAtMillis = Date.parse(startedAt);
    const bootMillis = Date.now() - os.uptime() * 1000;
    return Number.isNaN(startedAtMillis) || startedAtMillis < bootMillis - BOOT_TIME_TOLERANCE_MILLIS;
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

        // A daemon.json written before the last boot is stale, even if another process now has its PID.
        if (startedBeforeBoot(data.startedAt) || !isProcessAlive(data.pid)) {
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
 * IPC version the daemon reported. Builds that predate the field wrote none;
 * treat those as version 0.
 */
export function daemonIpcVersion(info: DaemonInfo): number {
    return info.ipcVersion ?? 0;
}

export function isIpcCompatible(info: DaemonInfo): boolean {
    return daemonIpcVersion(info) === IPC_VERSION;
}

/**
 * Human-readable explanation of an IPC version mismatch, with the fix.
 * A daemon left behind by an older or newer CLI build keeps running after
 * an upgrade; the user has to restart it to pick up the new code.
 */
export function ipcMismatchMessage(info: DaemonInfo): string {
    const versions = `daemon IPC v${daemonIpcVersion(info)}, this CLI expects v${IPC_VERSION}`;
    if (info.host === DaemonHost.APP) {
        return `The Pinggy app is running a daemon from a different version (${versions}). Update or restart the Pinggy app.`;
    }
    return `A daemon from a different Pinggy CLI version is running (PID ${info.pid}; ${versions}). `
        + `Run "pinggy daemon stop" and retry. This stops all running tunnels.`;
}

/**
 * Tells the user once per CLI version that the daemon runs an older build. The daemon keeps the code it started with,
 * so after an update the 2 differ until it restarts.
 */
export function printDaemonVersionNoticeOnce(
    info: DaemonInfo,
    restartInstruction: (daemon: DaemonInfo) => string | null = serviceRestartInstruction,
    running: string = getVersion(),
): void {
    if (process.stdout.isTTY !== true || info.host === DaemonHost.APP) return;
    if (!running || info.cliVersion === running || readUpdateState().lastDaemonNoticeVersion === running) return;

    const runs = info.cliVersion ? `The daemon runs ${info.cliVersion}.` : "The daemon runs an older version.";
    const instruction = restartInstruction(info) ?? DAEMON_STOP_INSTRUCTION;
    // Written first, so a state file that cannot be written does not repeat the line on every command.
    if (writeUpdateState({ lastDaemonNoticeVersion: running })) {
        CLIPrinter.print(`${runs} Run ${instruction} to start ${running}. This stops all running tunnels.`);
    }
}

export interface DaemonSpawnArgs {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

let installedBinaryForDaemon: string | null = null;

/**
 * Called after a downloaded binary installs itself. A daemon from the download would keep that file in use, so on
 * Windows the user could not delete it, and the daemon would not follow the installed copy's updates.
 */
export function startDaemonFromInstalledBinary(binaryPath: string): void {
    installedBinaryForDaemon = binaryPath;
}

/**
 * An update can prune the versioned file a long-lived foreground process runs from. That process keeps its code, but
 * cannot start anything from that path, so it starts the daemon from the link. If that daemon speaks another IPC
 * version, the caller gets the usual mismatch error.
 */
export function getDaemonSpawnArgs(
    isPackaged: boolean = isPackagedBinary(),
    executableExists: boolean = fs.existsSync(process.execPath),
    linkPath: string = unixLayoutPaths(os.homedir()).link,
    installedBinary: string | null = installedBinaryForDaemon,
): DaemonSpawnArgs {
    if (isPackaged && installedBinary) {
        return { command: installedBinary, args: ["--_daemon-child"], env: { ...process.env } };
    }
    if (isPackaged && !executableExists) {
        return { command: linkPath, args: ["--_daemon-child"], env: { ...process.env } };
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
    const existing = getDaemonInfo();
    if (existing) {
        return existing;
    }

    const { command, args, env } = getDaemonSpawnArgs();
    logger.info("Spawning daemon child", { command, args });

    let stderrOutput = "";
    let exited = false;
    let exitCode: number | null = null;

    const child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env,
        ...(os.platform() === "win32" ? { windowsHide: true } : {}),
    });

    child.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString("utf-8");
    });
    child.on("exit", (code) => {
        exited = true;
        exitCode = code;
    });
    // Without a listener, a failed spawn is an unhandled event and takes this process down.
    child.on("error", (error) => {
        exited = true;
        exitCode = SPAWN_FAILED_EXIT_CODE;
        stderrOutput = errorMessage(error);
    });
    child.unref();

    // Exit code 0: another daemon holds daemon.lock and may still be starting, so keep polling.
    const info = await pollForDaemonInfo(DAEMON_SPAWN_TIMEOUT_MS, () => exited && exitCode !== 0);
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
 *   Throws if that daemon speaks a different IPC version (left over from another CLI build).
 * - Inside Electron (`process.versions.electron`), starts the daemon in-process via
 *   runDaemonChild(). The host retrieve the handle with
 *   getInProcessDaemonHandle() to shut it down on app quit.
 * - Otherwise, spawns a detached daemon child.
 */
export async function ensureDaemonRunning(): Promise<DaemonInfo> {
    const existing = getDaemonInfo();
    if (existing) {
        if (!isIpcCompatible(existing)) throw new Error(ipcMismatchMessage(existing));
        return existing;
    }

    if (process.versions.electron) {
        const { runDaemonChild } = await import("./daemonChild.js");
        const handle = await runDaemonChild({
            installSignalHandlers: false,
            exitOnFailure: false,
            host: DaemonHost.APP,
        });
        inProcessHandle = handle;
        return (
            getDaemonInfo() ?? {
                pid: handle.pid,
                port: handle.port,
                startedAt: new Date().toISOString(),
                host: DaemonHost.APP,
                ipcVersion: IPC_VERSION,
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
 * Snapshot of tunnels currently running in the daemon.
 * queries the daemon over HTTP via GET /tunnels.
 */
export async function getActiveTunnelSummaries(origin: ClientOrigin = "app"): Promise<ActiveTunnelSummary[]> {
    const info = getDaemonInfo();
    if (!info) return [];

    const { IPCClient } = await import("../ipc/ipcClient.js");
    const client = new IPCClient(info.port, origin);
    let tunnels;
    try {
        tunnels = await client.listTunnels();
    } catch (err) {
        logger.warn("Failed to list tunnels from daemon", { error: errorMessage(err) });
        return [];
    }
    if (!Array.isArray(tunnels)) return [];

    return tunnels
        .filter(t => {
            const state = t?.status?.state;
            return state !== TunnelStateType.Closed && state !== TunnelStateType.Exited;
        })
        .map(t => ({
            tunnelId: t.tunnelid,
            name: t.tunnelconfig?.name || t.tunnelid.slice(0, 8),
            localAddress: getLocalAddress(t.tunnelconfig),
            urls: t.remoteurls ?? [],
        }));
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
    | { ok: false; error: string; reason?: typeof DaemonHost.APP };


export async function stopDaemon(): Promise<StopDaemonResult> {
    const info = getDaemonInfo();
    if (!info) return { ok: false, error: "No daemon is running." };

    let daemonErrors: string[] = [];
    try {
        const { IPCClient } = await import("../ipc/ipcClient.js");
        const client = new IPCClient(info.port);
        const result = await client.shutdown();
        logger.debug("Sent shutdown command to daemon", { result });
        if (result?.status === ShutdownStatus.RefusedInApp) {
            return {
                ok: false,
                reason: DaemonHost.APP,
                error: "The daemon is running inside the Pinggy app.",
            };
        }
        if (Array.isArray(result?.errors)) daemonErrors = result.errors;
    } catch (e) {
        return { ok: false, error: `Failed to reach daemon: ${errorMessage(e)}` };
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
