/**
 * Daemon child process entry point.
 * Called when the CLI is invoked with --_daemon-child.
 *
 * Responsibilities:
 * 1. Redirect stdout/stderr to daemon.log
 * 2. Start the IPC HTTP server
 * 3. Write daemon.json (port + pid) atomically
 * 4. Start all auto-start tunnels
 * 5. Handle graceful shutdown (cleanup daemon.json)
 */
import fs from "node:fs";
import { IPCServer } from "./ipcServer.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { enablePackageLogging, logger } from "../logger.js";
import { getDaemonInfoPath, getDaemonLogPath, ensurePinggyConfigDir } from "../utils/configDir.js";
import { getAutoStartConfigs, SavedTunnelConfig } from "../cli/configStore.js";
import { FinalConfig } from "../types.js";

export interface DaemonInfo {
    pid: number;
    port: number;
    startedAt: string;
}

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
function removeDaemonInfo(): void {
    try {
        const infoPath = getDaemonInfoPath();
        if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);
    } catch {
        // Best effort
    }
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

    const tunnel = await manager.createTunnel(config);
    await manager.startTunnel(tunnel.tunnelid);

    const urls = await manager.getTunnelUrls(tunnel.tunnelid);
    logger.info(`Tunnel "${saved.name}" started`, { tunnelId: tunnel.tunnelid, urls });

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

export async function runDaemonChild(): Promise<void> {
    ensurePinggyConfigDir();

    // Configure logging to daemon log file
    const logPath = getDaemonLogPath();
    enablePackageLogging({
        level: "debug",
        filePath: logPath,
        stdout: false,
        enableSdkLog: true,
    });

    logger.info("Daemon child process starting", { pid: process.pid });

    const manager = TunnelManager.getInstance();
    const ipcServer = new IPCServer();

    // Cleanup on exit signals
    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        logger.info("Daemon shutting down");
        manager.stopAllTunnels();
        removeDaemonInfo();
    };

    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("exit", cleanup);

    // Catch unhandled errors so the daemon doesn't silently crash
    process.on("uncaughtException", (err) => {
        logger.error("Daemon uncaught exception", { error: err.message, stack: err.stack });
    });
    process.on("unhandledRejection", (reason) => {
        logger.error("Daemon unhandled rejection", { reason: String(reason) });
    });

    try {
        // Start IPC server
        const port = await ipcServer.listen();

        // Write daemon.json atomically
        const info: DaemonInfo = {
            pid: process.pid,
            port,
            startedAt: new Date().toISOString(),
        };
        writeDaemonInfo(info);
        logger.info("Daemon info written", info);

        // Start all auto-start tunnels
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
    } catch (err: any) {
        logger.error("Daemon failed to start", { error: err.message });
        removeDaemonInfo();
        process.exit(1);
    }
}
