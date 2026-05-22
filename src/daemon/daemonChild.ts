/**
 * Daemon child process entry point.
 * Called when the CLI is invoked with --_daemon-child.
 *
 * Responsibilities:
 * 1. Redirect stdout/stderr to daemon.log
 * 2. Start the IPC HTTP + WebSocket server
 * 3. Write daemon.json (port + pid) atomically
 * 4. Crash recovery: restore tunnels from daemon-state.json
 * 5. Start all auto-start tunnels
 * 6. Handle graceful shutdown (cleanup daemon.json + state file)
 */
import fs from "node:fs";
import { IPCServer } from "./ipcServer.js";
import { SessionTracker } from "./sessionTracker.js";
import {
    loadDaemonState,
    persistDaemonState,
    clearDaemonState,
    addTunnelToState,
    removeTunnelFromState,
    DaemonState,
    DaemonStateTunnel,
} from "./stateStore.js";
import { TunnelManager, TunnelOrigin } from "../tunnel_manager/TunnelManager.js";
import { enablePackageLogging, logger, setLogLevel } from "../logger.js";
import { getDaemonInfoPath, getDaemonLogPath, ensurePinggyConfigDir, ensurePinggyLogDir } from "../utils/configDir.js";
import { detachAllTunnelLoggers } from "../logger/tunnelLogger.js";
import { getAutoStartConfigs, SavedTunnelConfig } from "../cli/configStore.js";
import { FinalConfig } from "../types.js";

export interface DaemonInfo {
    pid: number;
    port: number;
    startedAt: string;
}

export interface DaemonHandle {
    pid: number;
    port: number;
    shutdown: () => void;
}

export interface RunDaemonOptions {
    /**
     * Install POSIX signal handlers (SIGTERM/SIGINT/exit/uncaught) that tear
     * the daemon down and exit the process. Set to false when hosting the
     * daemon inside another application that owns its own lifecycle.
     * Default: true.
     */
    installSignalHandlers?: boolean;

    /**
     * Call process.exit(1) on startup failure. Set to false when hosting the
     * daemon in-process so the caller can handle the error.
     * Default: true.
     */
    exitOnFailure?: boolean;
}

// Module-level state for persistence
let daemonState: DaemonState = { tunnels: [], lastUpdated: "" };

/**
 * Write daemon.json atomically (write to tmp, then rename).
 */
function writeDaemonInfo(info: DaemonInfo): void {
    ensurePinggyConfigDir();
    const infoPath = getDaemonInfoPath();
    const tmpPath = infoPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), "utf-8");
    fs.renameSync(tmpPath, infoPath);
}

/**
 * Remove daemon.json on exit.
 */
export function removeDaemonInfo(): void {
    try {
        const infoPath = getDaemonInfoPath();
        if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);
    } catch {
        // Best effort
    }
}

/**
 * Track a tunnel start in the persistent state.
 */
export function trackTunnelStart(
    tunnelId: string,
    configId: string,
    name: string,
    origin: TunnelOrigin,
    config: FinalConfig,
    mode: "foreground" | "detached"
): void {
    const entry: DaemonStateTunnel = {
        tunnelId,
        configId,
        name,
        origin,
        config,
        mode,
        startedAt: new Date().toISOString(),
    };
    addTunnelToState(daemonState, entry);
    persistDaemonState(daemonState);
}

/**
 * Track a tunnel stop in the persistent state.
 */
export function trackTunnelStop(tunnelId: string): void {
    removeTunnelFromState(daemonState, tunnelId);
    persistDaemonState(daemonState);
}

export function trackIPCTunnelStart(tunnelId: string, origin: TunnelOrigin): void {
    const manager = TunnelManager.getInstance();
    const managed = manager.getManagedTunnel("", tunnelId);
    if (!managed?.tunnelConfig) return;
    trackTunnelStart(
        tunnelId,
        managed.configId,
        managed.tunnelName ?? "",
        origin,
        managed.tunnelConfig as FinalConfig,
        "detached",
    );
}

/**
 * Start a saved tunnel config in noTui mode.
 */
async function startSavedTunnel(saved: SavedTunnelConfig, manager: TunnelManager): Promise<void> {
    const config: FinalConfig = {
        ...saved.tunnelConfig,
        configId: saved.configId,
        name: saved.name,
        optional: {
            ...saved.tunnelConfig.optional,
            noTui: true,
        },
    };

    const tunnel = await manager.createTunnel(config, "cli");
    await manager.startTunnel(tunnel.tunnelid);

    const urls = await manager.getTunnelUrls(tunnel.tunnelid);
    logger.info(`Tunnel "${saved.name}" started`, { tunnelId: tunnel.tunnelid, urls });

    // Track in state for crash recovery
    trackTunnelStart(tunnel.tunnelid, saved.configId, saved.name, "cli", saved.tunnelConfig, "detached");

    // Register reconnection listeners for resilience
    manager.registerWorkerErrorListner(tunnel.tunnelid, (_id, error) => {
        logger.error(`[${saved.name}] Fatal error: ${error.message}`);
    });

    manager.registerReconnectingListener(tunnel.tunnelid, (_id, retryCnt) => {
        logger.info(`[${saved.name}] Reconnecting (attempt #${retryCnt})`);
    });

    manager.registerReconnectionCompletedListener(tunnel.tunnelid, (_id, newUrls) => {
        logger.info(`[${saved.name}] Reconnected`, { urls: newUrls });
    });

    manager.registerReconnectionFailedListener(tunnel.tunnelid, (_id, retryCnt) => {
        logger.error(`[${saved.name}] Reconnection failed after ${retryCnt} attempts`);
    });
}

/**
 * Restore tunnels from crash recovery state.
 * Only restores detached tunnels (foreground tunnels have no CLI to attach to).
 */
async function restoreCrashedTunnels(manager: TunnelManager): Promise<void> {
    const savedState = loadDaemonState();
    if (!savedState || savedState.tunnels.length === 0) return;

    const detachedTunnels = savedState.tunnels.filter(t => t.mode === "detached");
    if (detachedTunnels.length === 0) {
        logger.info("Crash recovery: no detached tunnels to restore");
        clearDaemonState();
        return;
    }

    logger.info(`Crash recovery: restoring ${detachedTunnels.length} detached tunnel(s)`);

    for (const entry of detachedTunnels) {
        try {
            const config = {
                ...entry.config,
                configId: entry.configId,
                name: entry.name,
                tunnelid: entry.tunnelId,  // reuse stable ID for log file continuity
                optional: {
                    ...(entry.config as any).optional,
                    noTui: true,
                },
            } as FinalConfig;

            const tunnel = await manager.createTunnel(config, entry.origin);
            await manager.startTunnel(tunnel.tunnelid);

            const urls = await manager.getTunnelUrls(tunnel.tunnelid);
            logger.info(`Restored tunnel "${entry.name}"`, { tunnelId: tunnel.tunnelid, urls });

            // Track new tunnel ID in state
            trackTunnelStart(tunnel.tunnelid, entry.configId, entry.name, entry.origin, entry.config, "detached");

            // Register resilience listeners
            manager.registerWorkerErrorListner(tunnel.tunnelid, (_id, error) => {
                logger.error(`[${entry.name}] Fatal error: ${error.message}`);
            });
            manager.registerReconnectingListener(tunnel.tunnelid, (_id, retryCnt) => {
                logger.info(`[${entry.name}] Reconnecting (attempt #${retryCnt})`);
            });
            manager.registerReconnectionCompletedListener(tunnel.tunnelid, (_id, newUrls) => {
                logger.info(`[${entry.name}] Reconnected`, { urls: newUrls });
            });
            manager.registerReconnectionFailedListener(tunnel.tunnelid, (_id, retryCnt) => {
                logger.error(`[${entry.name}] Reconnection failed after ${retryCnt} attempts`);
            });
        } catch (err: any) {
            logger.error(`Failed to restore tunnel "${entry.name}"`, { error: err.message });
        }
    }
}

export async function runDaemonChild(opts: RunDaemonOptions = {}): Promise<DaemonHandle> {
    const installSignalHandlers = opts.installSignalHandlers ?? true;
    const exitOnFailure = opts.exitOnFailure ?? true;

    ensurePinggyConfigDir();

    // Configure logging to daemon log file
    const initialLevel = (process.env.PINGGY_LOG_LEVEL as any) || "info";
    setLogLevel(initialLevel);
    ensurePinggyLogDir();
    const logPath = getDaemonLogPath();
    enablePackageLogging({
        level: initialLevel,
        filePath: logPath,
        stdout: false,
        enableSdkLog: true,
    });

    logger.info("Daemon starting", { pid: process.pid, inProcess: !installSignalHandlers });

    const manager = TunnelManager.getInstance();
    const ipcServer = new IPCServer();
    const sessionTracker = new SessionTracker();

    // Wire session tracker to IPC server
    ipcServer.setOnSessionDisconnect((session) => {
        sessionTracker.onSessionDisconnect(session);
    });
    ipcServer.setSessionTracker(sessionTracker);

    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        logger.info("Daemon shutting down");
        try { removeDaemonInfo(); } catch {  }
        try { clearDaemonState(); } catch {  }
        try { sessionTracker.destroy(); } catch {  }
        try { detachAllTunnelLoggers(); } catch {}
        try { manager.stopAllTunnels(); } catch {  }
        try { ipcServer.close(); } catch {  }
    };

    if (installSignalHandlers) {
        process.on("SIGTERM", () => { cleanup(); process.exit(0); });
        process.on("SIGINT", () => { cleanup(); process.exit(0); });
        process.on("exit", cleanup);

        process.on("uncaughtException", (err) => {
            logger.error("Daemon uncaught exception", { error: err.message, stack: err.stack });
        });
        process.on("unhandledRejection", (reason) => {
            logger.error("Daemon unhandled rejection", { reason: String(reason) });
        });
    }

    try {
        const port = await ipcServer.listen();

        const info: DaemonInfo = {
            pid: process.pid,
            port,
            startedAt: new Date().toISOString(),
        };
        writeDaemonInfo(info);
        logger.info("Daemon info written", info);

        await restoreCrashedTunnels(manager);

        const configs = getAutoStartConfigs();
        if (configs.length > 0) {
            logger.info(`Starting ${configs.length} auto-start tunnel(s)`);
            for (const saved of configs) {
                try {
                    await startSavedTunnel(saved, manager);
                } catch (err: any) {
                    logger.error(`Failed to start tunnel "${saved.name}"`, { error: err.message });
                }
            }
        } else {
            logger.info("No auto-start tunnels configured");
        }

        logger.info("Daemon ready", { pid: process.pid, port });

        return {
            pid: process.pid,
            port,
            shutdown: cleanup,
        };
    } catch (err: any) {
        logger.error("Daemon failed to start", { error: err.message });
        removeDaemonInfo();
        if (exitOnFailure) {
            process.exit(1);
        }
        throw err;
    }
}
