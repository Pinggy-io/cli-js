/**
 * Manages the lifecycle and state of multiple tunnel instances.
 * Implements the Singleton pattern to ensure only one tunnel manager exists in the application.
 * 
 * @remarks
 * This class provides comprehensive tunnel management capabilities including:
 * - Creation and initialization of tunnels
 * - Starting and stopping tunnels
 * - Managing tunnel configurations and states
 * - Handling additional forwarding rules
 * - Monitoring tunnel status
 * 
 * @sealed
 * @singleton
 */
import { pinggy, type PinggyOptions, type TunnelInstance, type TunnelUsageType } from "@pinggy/pinggy";
import { logger } from "../logger.js";
import { v4 as uuidv4 } from "uuid";
import { AdditionalForwarding, TunnelWarningCode, Warning } from "../types.js";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import CLIPrinter from "../utils/printer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ManagedTunnel {
    tunnelid: string;
    configid: string;
    tunnelName?: string;
    instance: TunnelInstance;
    tunnelConfig?: PinggyOptions;
    additionalForwarding?: AdditionalForwarding[];
    serveWorker?: Worker | null;
    warnings?: Warning[];
    serve?: string;
}

export interface TunnelList {
    tunnelid: string;
    configid: string;
    tunnelName?: string;
    tunnelConfig: PinggyOptions;
    remoteurls: string[];
}

export type StatsListener = (tunnelId: string, stats: TunnelUsageType) => void;
export type ErrorListener = (tunnelId: string, errorMsg: string, isFatal: boolean) => void;
export type DisconnectListener = (tunnelId: string, error: string, messages: string[]) => void;
export type TunnelWorkerErrorListner = (tunnelid: string, error: Error) => void;

export interface ITunnelManager {
    createTunnel(config: (PinggyOptions & { configid: string; tunnelid?: string; tunnelName?: string }) & { additionalForwarding?: AdditionalForwarding[] }): ManagedTunnel;
    startTunnel(tunnelId: string): Promise<string[]>;
    stopTunnel(tunnelId: string): { configid: string; tunnelid: string };
    stopAllTunnels(): void;
    getTunnelUrls(tunnelId: string): Promise<string[]>;
    getAllTunnels(): Promise<TunnelList[]>;
    getTunnelStatus(tunnelId: string): Promise<string>;
    getTunnelInstance(configId?: string, tunnelId?: string): TunnelInstance;
    getTunnelConfig(configId?: string, tunnelId?: string): Promise<PinggyOptions>;
    restartTunnel(tunnelId: string, config: PinggyOptions): Promise<void>;
    updateConfig(
        newConfig: PinggyOptions & { configid: string; additionalForwarding?: AdditionalForwarding[], tunnelName?: string },
    ): Promise<ManagedTunnel>;
    getManagedTunnel(configId?: string, tunnelId?: string): ManagedTunnel;
    getTunnelGreetMessage(tunnelId: string): Promise<string | null>;
    getTunnelStats(tunnelId: string): TunnelUsageType | null;
    registerStatsListener(tunnelId: string, listener: StatsListener): string;
    registerErrorListener(tunnelId: string, listener: ErrorListener): string;
    registerWorkerErrorListner(tunnelId: string, listener: TunnelWorkerErrorListner): void;
    deregisterErrorListener(tunnelId: string, listenerId: string): void;
    registerDisconnectListener(tunnelId: string, listener: DisconnectListener): string;
    deregisterDisconnectListener(tunnelId: string, listenerId: string): void;
    deregisterStatsListener(tunnelId: string, listenerId: string): void;
    getLocalserverTlsInfo(tunnelId: string): Promise<string | boolean>;
}

export class TunnelManager implements ITunnelManager {

    private static instance: TunnelManager;
    private tunnelsByTunnelId: Map<string, ManagedTunnel> = new Map();
    private tunnelsByConfigId: Map<string, ManagedTunnel> = new Map();
    private tunnelStats: Map<string, TunnelUsageType> = new Map();
    private tunnelStatsListeners: Map<string, Map<string, StatsListener>> = new Map();
    private tunnelErrorListeners: Map<string, Map<string, ErrorListener>> = new Map();
    private tunnelDisconnectListeners: Map<string, Map<string, DisconnectListener>> = new Map();
    private tunnelWorkerErrorListeners: Map<string, Map<string, TunnelWorkerErrorListner>> = new Map();

    private constructor() { }

    public static getInstance(): TunnelManager {
        if (!TunnelManager.instance) {
            TunnelManager.instance = new TunnelManager();
        }
        return TunnelManager.instance;
    }

    /**
     * Creates a new managed tunnel instance with the given configuration.
     * 
     * @param config - The tunnel configuration options
     * @param config.configid - Unique identifier for the tunnel configuration
     * @param config.tunnelid - Optional custom tunnel identifier. If not provided, a random UUID will be generated
     * @param config.additionalForwarding - Optional array of additional forwarding configurations
     * 
     * @throws {Error} When configId is invalid or empty
     * @throws {Error} When a tunnel with the given configId already exists
     * 
     * @returns {ManagedTunnel} A new managed tunnel instance containing the tunnel details,
     *                          status information, and statistics
     */
    createTunnel(config: (PinggyOptions & { configid: string; tunnelid?: string; tunnelName?: string }) & { additionalForwarding?: AdditionalForwarding[] } & { serve?: string }): ManagedTunnel {
        const { configid, additionalForwarding, tunnelName } = config;
        if (configid === undefined || configid.trim().length === 0) {
            throw new Error(`Invalid configId: "${configid}"`);
        }
        if (this.tunnelsByConfigId.has(configid)) {
            throw new Error(`Tunnel with configId "${configid}" already exists`);
        }

        const tunnelid = config.tunnelid || uuidv4();
        const instance = pinggy.createTunnel(config);

        const managed: ManagedTunnel = {
            tunnelid,
            configid,
            tunnelName,
            instance,
            tunnelConfig: config,
            additionalForwarding,
            serve: config.serve,
            warnings: []
        }

        // Register stats & error callback for this tunnel
        this.setupStatsCallback(tunnelid, managed);
        this.setupErrorCallback(tunnelid, managed);
        this.setupDisconnectCallback(tunnelid, managed);
        this.setUpTunnelWorkerErrorCallback(tunnelid, managed)

        this.tunnelsByTunnelId.set(tunnelid, managed);
        this.tunnelsByConfigId.set(configid, managed);
        logger.info("Tunnel created", { configid, tunnelid });
        return managed;
    }

    /**
     * Start a tunnel that was created but not yet started
     */
    async startTunnel(tunnelId: string): Promise<string[]> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel with id "${tunnelId}" not found`);

        logger.info("Starting tunnel", { tunnelId });
        let urls: string[];
        try {
            urls = await managed.instance.start();
        } catch (error) {
            logger.error("Failed to start tunnel", { tunnelId, error });
            throw error;
        }

        logger.info("Tunnel started", { tunnelId, urls });

        // Apply any additional forwarding after the tunnel has started
        if (Array.isArray(managed.additionalForwarding) && managed.additionalForwarding.length > 0) {

            for (const f of managed.additionalForwarding) {
                try {
                    if (!f ||
                        typeof f.remotePort !== 'number' ||
                        !f.localDomain ||
                        typeof f.localPort !== 'number') {
                        logger.warn(`Skipping invalid additional forwarding rule: ${JSON.stringify(f)}`);
                        continue;
                    }
                    const hostname = f.remoteDomain && f.remoteDomain.length > 0
                        ? `${f.remoteDomain}:${f.remotePort}`
                        : `${f.remotePort}`;
                    const target = `${f.localDomain}:${f.localPort}`;

                    await managed.instance.tunnelRequestAdditionalForwarding(hostname, target);
                    logger.info("Applied additional forwarding", { tunnelId, hostname, target });
                } catch (e) {

                    logger.warn(`Failed to apply additional forwarding (${JSON.stringify(f)}):`, e);
                }
            }
        }

        if (managed.serve) {
            this.startStaticFileServer(managed)
        }
        return urls;
    }

    /**
     * Stops a running tunnel and updates its status.
     *
     * @param tunnelId - The unique identifier of the tunnel to stop
     * @throws {Error} If the tunnel with the given tunnelId is not found
     * @remarks
     * - Clears the tunnel's remote URLs
     * - Updates the tunnel's state to Exited if stopped successfully
     * - Logs the stop operation with tunnelId and configId
     */
    stopTunnel(tunnelId: string): { configid: string; tunnelid: string } {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);

        logger.info("Stopping tunnel", { tunnelId, configId: managed.configid });
        try {
            managed.instance.stop();
            if (managed.serveWorker) {
                logger.info("terminating serveWorker");
                managed.serveWorker.terminate();
            }
            this.tunnelStats.delete(tunnelId);
            this.tunnelStatsListeners.delete(tunnelId);
            logger.info("Tunnel stopped", { tunnelId });
            return { configid: managed.configid, tunnelid: managed.tunnelid };
        } catch (error) {
            logger.error("Failed to stop tunnel", { tunnelId, error });
            throw error;
        }
    }

    /**
     * Get all public URLs for a tunnel
     */
    async getTunnelUrls(tunnelId: string): Promise<string[]> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            logger.error(`Tunnel "${tunnelId}" not found when fetching URLs`);
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }
        const urls = await managed.instance.urls();
        logger.debug("Queried tunnel URLs", { tunnelId, urls });
        return urls;
    }

    /**
     * Get all TunnelStatus currently managed by this TunnelManager
     * @returns An array of all TunnelStatus objects
     */
    async getAllTunnels(): Promise<TunnelList[]> {

        const tunnelList = await Promise.all(Array.from(this.tunnelsByTunnelId.values()).map(async (tunnel) => ({
            tunnelid: tunnel.tunnelid,
            configid: tunnel.configid,
            tunnelName: tunnel.tunnelName,
            tunnelConfig: tunnel.tunnelConfig!,
            remoteurls: await this.getTunnelUrls(tunnel.tunnelid)
        })));
        return tunnelList;
    }

    /**
     * Get status of a tunnel
     */
    async getTunnelStatus(tunnelId: string): Promise<string> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            logger.error(`Tunnel "${tunnelId}" not found when fetching status`);
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }
        const status = await managed.instance.getStatus();
        logger.debug("Queried tunnel status", { tunnelId, status });
        return status;
    }

    /**
     * Stop all tunnels
     */
    stopAllTunnels(): void {
        for (const { instance } of this.tunnelsByTunnelId.values()) {
            try {
                instance.stop();
            } catch (e) {
                logger.warn("Error stopping tunnel instance", e);
            }
        }
        this.tunnelsByTunnelId.clear();
        this.tunnelsByConfigId.clear();
        this.tunnelStats.clear();
        this.tunnelStatsListeners.clear();
        logger.info("All tunnels stopped and cleared");
    }

    /**
     * Get tunnel instance by either configId or tunnelId
     * @param configId - The configuration ID of the tunnel
     * @param tunnelId - The tunnel ID
     * @returns The tunnel instance
     * @throws Error if neither configId nor tunnelId is provided, or if tunnel is not found
     */
    getTunnelInstance(configId?: string, tunnelId?: string): TunnelInstance {
        if (configId) {
            const managed = this.tunnelsByConfigId.get(configId);
            if (!managed) throw new Error(`Tunnel "${configId}" not found`);
            return managed.instance;
        }
        if (tunnelId) {
            const managed = this.tunnelsByTunnelId.get(tunnelId);
            if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
            return managed.instance;
        }
        throw new Error(`Either configId or tunnelId must be provided`);
    }

    /**
     * Get tunnel config by either configId or tunnelId
     * @param configId - The configuration ID of the tunnel
     * @param tunnelId - The tunnel ID
     * @returns The tunnel config
     * @throws Error if neither configId nor tunnelId is provided, or if tunnel is not found
     */
    async getTunnelConfig(configId?: string, tunnelId?: string): Promise<PinggyOptions> {
        if (configId) {
            const managed = this.tunnelsByConfigId.get(configId);
            if (!managed) {
                throw new Error(`Tunnel with configId "${configId}" not found`);
            }
            return <PinggyOptions>managed.instance.getConfig();
        }
        if (tunnelId) {
            const managed = this.tunnelsByTunnelId.get(tunnelId);
            if (!managed) {
                throw new Error(`Tunnel with tunnelId "${tunnelId}" not found`);
            }
            return <PinggyOptions>managed.instance.getConfig();
        }
        throw new Error(`Either configId or tunnelId must be provided`);
    }

    /**
     * Restarts a tunnel with its current configuration.
     * This function will stop the tunnel if it's running and start it again.
     * All configurations including additional forwarding rules are preserved.
     */
    async restartTunnel(tunnelid: string): Promise<void> {
        // Get the existing tunnel
        const existingTunnel = this.tunnelsByTunnelId.get(tunnelid);
        if (!existingTunnel) {
            throw new Error(`Tunnel "${tunnelid}" not found`);
        }

        logger.info("Initiating tunnel restart", {
            tunnelId: tunnelid,
            configId: existingTunnel.configid
        });

        try {
            // Store the current configuration
            const tunnelName = existingTunnel.tunnelName;
            const currentConfigId = existingTunnel.configid;
            const currentConfig = existingTunnel.tunnelConfig;
            const additionalForwarding = existingTunnel.additionalForwarding;
            // Remove the existing tunnel
            this.tunnelsByTunnelId.delete(tunnelid);
            this.tunnelsByConfigId.delete(existingTunnel.configid);
            this.tunnelStats.delete(tunnelid);
            this.tunnelStatsListeners.delete(tunnelid);

            // Create a new tunnel with the same configuration
            const newTunnel = this.createTunnel({
                ...currentConfig,
                configid: currentConfigId,
                tunnelid,
                additionalForwarding,
                tunnelName,
            });

            // Start the new tunnel
            this.startTunnel(newTunnel.tunnelid);

        } catch (error) {
            logger.error("Failed to restart tunnel", {
                tunnelid,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            throw new Error(`Failed to restart tunnel: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Updates the configuration of an existing tunnel.
     * 
     * This method handles the process of updating a tunnel's configuration while preserving
     * its state. If the tunnel is running, it will be stopped, updated, and restarted.
     * In case of failure, it attempts to restore the original configuration.
     * 
     * @param tunnelId - The unique identifier of the tunnel to update
     * @param newConfig - The new configuration to apply, including configid and optional additional forwarding
     * @param preserveAdditionalForwarding - Whether to preserve existing additional forwarding rules (default: true)
     * 
     * @returns Promise resolving to an object containing the tunnel ID and array of URLs (if tunnel was running)
     * @throws Error if the tunnel is not found or if the update process fails
     * 
     * @example
     * const result = await tunnelManager.updateConfig('tunnel123', {
     *   configid: 'config456',
     *   port: 8080
     * });
     */
    async updateConfig(
        newConfig: PinggyOptions & { configid: string; additionalForwarding?: AdditionalForwarding[], tunnelName?: string },
    ): Promise<ManagedTunnel> {
        const { configid, tunnelName: newTunnelName, additionalForwarding } = newConfig;

        if (!configid || configid.trim().length === 0) {
            throw new Error(`Invalid configid: "${configid}"`);
        }
        // Get the existing tunnel
        const existingTunnel = this.tunnelsByConfigId.get(configid);
        if (!existingTunnel) {
            throw new Error(`Tunnel with config id "${configid}" not found`);
        }

        // Store the current state
        const wasRunning = await existingTunnel.instance.getStatus() === 'live';
        const currentTunnelConfig = existingTunnel.tunnelConfig!;
        const currentTunnelId = existingTunnel.tunnelid;
        const currentTunnelConfigId = existingTunnel.configid;
        const currentAdditionalForwarding = existingTunnel.additionalForwarding;
        const currentTunnelName = existingTunnel.tunnelName;

        try {
            // Stop the existing tunnel if running
            if (wasRunning) {
                existingTunnel.instance.stop();
            }

            // Remove the old tunnel
            this.tunnelsByTunnelId.delete(currentTunnelId);
            this.tunnelsByConfigId.delete(currentTunnelConfigId);

            // Create new tunnel with merged configuration
            const mergedConfig = {
                ...currentTunnelConfig,
                ...newConfig,
                configid: configid,
                tunnelName: newTunnelName !== undefined ? newTunnelName : currentTunnelName,
                additionalForwarding: additionalForwarding !== undefined ? additionalForwarding : currentAdditionalForwarding
            };
            // Create the new tunnel
            const newTunnel = this.createTunnel(mergedConfig);

            // Start the tunnel if it was running before
            if (wasRunning) {
                this.startTunnel(newTunnel.tunnelid);
            }

            logger.info("Tunnel configuration updated", {
                tunnelId: newTunnel.tunnelid,
                configId: newTunnel.configid,
                wasRunning: wasRunning
            });

            return newTunnel;

        } catch (error: any) {
            // If anything fails during the update, try to restore the previous state
            try {
                const originalTunnel = this.createTunnel({
                    ...currentTunnelConfig,
                    configid: existingTunnel.configid,
                    tunnelid: currentTunnelId,
                    tunnelName: currentTunnelName,
                    additionalForwarding: currentAdditionalForwarding
                });
                if (wasRunning) {
                    await this.startTunnel(originalTunnel.tunnelid);
                }
                logger.warn("Restored original tunnel configuration after update failure", {
                    currentTunnelId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            } catch (restoreError: any) {
                logger.error("Failed to restore original tunnel configuration", {
                    currentTunnelId,
                    error: restoreError instanceof Error ? restoreError.message : 'Unknown error'
                });
            }

            // Re-throw the original error
            throw error;
        }
    }

    /**
     * Retrieve the ManagedTunnel object by either configId or tunnelId.
     * Throws an error if neither id is provided or the tunnel is not found.
     */
    getManagedTunnel(configId?: string, tunnelId?: string): ManagedTunnel {
        if (configId) {
            const managed = this.tunnelsByConfigId.get(configId);
            if (!managed) throw new Error(`Tunnel "${configId}" not found`);
            return managed;
        }
        if (tunnelId) {
            const managed = this.tunnelsByTunnelId.get(tunnelId);
            if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
            return managed;
        }
        throw new Error(`Either configId or tunnelId must be provided`);

    }

    async getTunnelGreetMessage(tunnelId: string): Promise<string | null> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            logger.error(`Tunnel "${tunnelId}" not found when fetching greet message`);
            return null;
        }
        try {
            const messages = await managed.instance.getGreetMessage();
            if (Array.isArray(messages)) {
                return messages.join(" ");
            }
            return messages ?? null;
        } catch (e) {
            logger.error(
                `Error fetching greet message for tunnel "${tunnelId}": ${e instanceof Error ? e.message : String(e)
                }`
            );
            return null;
        }
    }



    getTunnelStats(tunnelId: string): TunnelUsageType | null {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            return null;
        }
        // Return the latest stats or null if none available yet
        const stats = this.tunnelStats.get(tunnelId);
        return stats || null;
    }

    /**
     * Registers a listener function to receive tunnel statistics updates.
     * The listener will be called whenever any tunnel's stats are updated.
     * 
     * @param tunnelId - The tunnel ID to listen to stats for
     * @param listener - Function that receives tunnelId and stats when updates occur
     * @returns A unique listener ID that can be used to deregister the listener
     */
    registerStatsListener(tunnelId: string, listener: StatsListener): string {
        // Verify tunnel exists
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        // Initialize listeners map for this tunnel if it doesn't exist
        if (!this.tunnelStatsListeners.has(tunnelId)) {
            this.tunnelStatsListeners.set(tunnelId, new Map());
        }

        const listenerId = uuidv4();
        const tunnelListeners = this.tunnelStatsListeners.get(tunnelId)!;
        tunnelListeners.set(listenerId, listener);

        logger.info("Stats listener registered for tunnel", { tunnelId, listenerId });
        return listenerId;
    }

    registerErrorListener(tunnelId: string, listener: ErrorListener): string {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        if (!this.tunnelErrorListeners.has(tunnelId)) {
            this.tunnelErrorListeners.set(tunnelId, new Map());
        }
        const listenerId = uuidv4();
        const tunnelErrorListeners = this.tunnelErrorListeners.get(tunnelId)!;
        tunnelErrorListeners.set(listenerId, listener);

        logger.info("Error listener registered for tunnel", { tunnelId, listenerId });
        return listenerId;
    }

    registerDisconnectListener(tunnelId: string, listener: DisconnectListener): string {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        if (!this.tunnelDisconnectListeners.has(tunnelId)) {
            this.tunnelDisconnectListeners.set(tunnelId, new Map());
        }
        const listenerId = uuidv4();
        const tunnelDisconnectListeners = this.tunnelDisconnectListeners.get(tunnelId)!;
        tunnelDisconnectListeners.set(listenerId, listener);

        logger.info("Disconnect listener registered for tunnel", { tunnelId, listenerId });
        return listenerId;
    }

    registerWorkerErrorListner(tunnelId: string, listener: TunnelWorkerErrorListner): void {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        if (!this.tunnelWorkerErrorListeners.has(tunnelId)) {
            this.tunnelWorkerErrorListeners.set(tunnelId, new Map());
        }
        const listenerId = uuidv4();
        const tunnelWorkerErrorListner = this.tunnelWorkerErrorListeners.get(tunnelId);
        tunnelWorkerErrorListner?.set(listenerId, listener);
        logger.info("TunnelWorker error listener registered for tunnel", { tunnelId, listenerId });
    }
    /**
     * Removes a previously registered stats listener.
     * 
    * @param tunnelId - The tunnel ID the listener was registered for
    * @param listenerId - The unique ID returned when the listener was registered
    */
    deregisterStatsListener(tunnelId: string, listenerId: string): void {
        const tunnelListeners = this.tunnelStatsListeners.get(tunnelId);
        if (!tunnelListeners) {
            logger.warn("No listeners found for tunnel", { tunnelId });
            return;
        }

        const removed = tunnelListeners.delete(listenerId);
        if (removed) {
            logger.info("Stats listener deregistered", { tunnelId, listenerId });

            // Clean up empty listener map
            if (tunnelListeners.size === 0) {
                this.tunnelStatsListeners.delete(tunnelId);
            }
        } else {
            logger.warn("Attempted to deregister non-existent stats listener", { tunnelId, listenerId });
        }
    }

    deregisterErrorListener(tunnelId: string, listenerId: string): void {
        const listeners = this.tunnelErrorListeners.get(tunnelId);
        if (!listeners) {
            logger.warn("No error listeners found for tunnel", { tunnelId });
            return;
        }
        const removed = listeners.delete(listenerId);
        if (removed) {
            logger.info("Error listener deregistered", { tunnelId, listenerId });
            if (listeners.size === 0) {
                this.tunnelErrorListeners.delete(tunnelId);
            }
        } else {
            logger.warn("Attempted to deregister non-existent error listener", { tunnelId, listenerId });
        }
    }

    deregisterDisconnectListener(tunnelId: string, listenerId: string): void {
        const listeners = this.tunnelDisconnectListeners.get(tunnelId);
        if (!listeners) {
            logger.warn("No disconnect listeners found for tunnel", { tunnelId });
            return;
        }
        const removed = listeners.delete(listenerId);
        if (removed) {
            logger.info("Disconnect listener deregistered", { tunnelId, listenerId });
            if (listeners.size === 0) {
                this.tunnelDisconnectListeners.delete(tunnelId);
            }
        } else {
            logger.warn("Attempted to deregister non-existent disconnect listener", { tunnelId, listenerId });
        }
    }

    async getLocalserverTlsInfo(tunnelId: string): Promise<string | false> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            logger.error(`Tunnel "${tunnelId}" not found when fetching local server TLS info`);
            return false;
        }

        try {
            const tlsInfo = await managed.instance.getLocalServerTls();
            if (tlsInfo) {
                return tlsInfo;
            }
            return false;
        } catch (e) {
            logger.error(`Error fetching TLS info for tunnel "${tunnelId}": ${e instanceof Error ? e.message : e}`);
            return false;
        }
    }


    /**
     * Sets up the stats callback for a tunnel during creation.
     * This callback will update stored stats and notify all registered listeners.
     */
    private setupStatsCallback(tunnelId: string, managed: ManagedTunnel): void {
        try {
            const callback = (usage: Record<string, any>) => {
                this.updateStats(tunnelId, usage);
            };

            // Set the callback on the tunnel instance
            managed.instance.setUsageUpdateCallback(callback);
            logger.debug("Stats callback set up for tunnel", { tunnelId });

        } catch (error) {
            logger.warn("Failed to set up stats callback", { tunnelId, error });
        }
    }

    private notifyErrorListeners(tunnelId: string, errorMsg: string, isFatal: boolean): void {
        try {
            const listeners = this.tunnelErrorListeners.get(tunnelId);
            if (!listeners) return;
            for (const [id, listener] of listeners) {
                try {
                    listener(tunnelId, errorMsg, isFatal);
                } catch (err) {
                    logger.debug("Error in error-listener callback", { listenerId: id, tunnelId, err });
                }
            }
        } catch (err) {
            logger.debug("Failed to notify error listeners", { tunnelId, err });
        }
    }

    private setupErrorCallback(tunnelId: string, managed: ManagedTunnel): void {
        try {
            const callback = (errorNo: number, errorMsg: string, recoverable: boolean) => {
                try {
                    const msg = typeof errorMsg === "string" ? errorMsg : String(errorMsg);
                    const isFatal = true;
                    logger.debug("Tunnel reported error", { tunnelId, errorNo, errorMsg: msg, recoverable });


                    this.notifyErrorListeners(tunnelId, msg, isFatal);

                    // TODO: IF the error is fatal, we can stop the tunnel and exit.
                } catch (e) {
                    logger.warn("Error handling tunnel error callback", { tunnelId, e });
                }
            };

            managed.instance.setTunnelErrorCallback(callback);
            logger.debug("Error callback set up for tunnel", { tunnelId });
        } catch (error) {
            logger.warn("Failed to set up error callback", { tunnelId, error });
        }
    }

    private setupDisconnectCallback(tunnelId: string, managed: ManagedTunnel): void {
        try {
            const callback = (error: string, messages: string[]) => {
                try {
                    logger.debug("Tunnel disconnected", { tunnelId, error, messages });

                    const listeners = this.tunnelDisconnectListeners.get(tunnelId);
                    if (!listeners) return;
                    for (const [id, listener] of listeners) {
                        try {
                            listener(tunnelId, error, messages);
                        } catch (err) {
                            logger.debug("Error in disconnect-listener callback", { listenerId: id, tunnelId, err });
                        }
                    }
                } catch (e) {
                    logger.warn("Error handling tunnel disconnect callback", { tunnelId, e });
                }
            };

            managed.instance.setTunnelDisconnectedCallback(callback);
            logger.debug("Disconnect callback set up for tunnel", { tunnelId });
        } catch (error) {
            logger.warn("Failed to set up disconnect callback", { tunnelId, error });
        }
    }

    private setUpTunnelWorkerErrorCallback(tunnelId: string, managed: ManagedTunnel): void {
        try {
            const callback = (error: Error) => {
                try {
                    logger.debug("Error in Tunnel Worker", { tunnelId, errorMessage: error.message });

                    const listeners = this.tunnelWorkerErrorListeners.get(tunnelId);
                    if (!listeners) return;
                    for (const [id, listener] of listeners) {
                        try {
                            listener(tunnelId, error);
                        } catch (err) {
                            logger.debug("Error in worker-error-listener callback", { listenerId: id, tunnelId, err });
                        }
                    }
                } catch (e) {
                    logger.warn("Error handling tunnel worker error callback", { tunnelId, e });
                }
            };

            managed.instance.setWorkerErrorCallback(callback);
            logger.debug("Disconnect callback set up for tunnel", { tunnelId });

        } catch (error) {
            logger.warn("Failed to setup tunnel worker error callback")

        }
    }


    /**
     * Updates the stored stats for a tunnel and notifies all registered listeners.
     */
    private updateStats(tunnelId: string, rawUsage: Record<string, any>): void {
        try {
            // Normalize the stats
            const normalizedStats = this.normalizeStats(rawUsage);

            // Store the latest stats
            this.tunnelStats.set(tunnelId, normalizedStats);

            // Notify all registered listeners for this specific tunnel
            const tunnelListeners = this.tunnelStatsListeners.get(tunnelId);
            if (tunnelListeners) {
                for (const [listenerId, listener] of tunnelListeners) {
                    try {
                        listener(tunnelId, normalizedStats);
                    } catch (error) {
                        logger.warn("Error in stats listener callback", { listenerId, tunnelId, error });
                    }
                }
            }

            logger.debug("Stats updated and listeners notified", {
                tunnelId,
                listenersCount: tunnelListeners?.size || 0
            });
        } catch (error) {
            logger.warn("Error updating stats", { tunnelId, error });
        }
    }

    /**
     * Normalizes raw usage data from the SDK into a consistent TunnelStats format.
     */
    private normalizeStats(rawStats: Record<string, any>): TunnelUsageType {
        const elapsed = this.parseNumber(rawStats.elapsedTime ?? 0);
        const liveConns = this.parseNumber(rawStats.numLiveConnections ?? 0);
        const totalConns = this.parseNumber(rawStats.numTotalConnections ?? 0);
        const reqBytes = this.parseNumber(rawStats.numTotalReqBytes ?? 0);
        const resBytes = this.parseNumber(rawStats.numTotalResBytes ?? 0);
        const txBytes = this.parseNumber(rawStats.numTotalTxBytes ?? 0);

        return {
            elapsedTime: elapsed,
            numLiveConnections: liveConns,
            numTotalConnections: totalConns,
            numTotalReqBytes: reqBytes,
            numTotalResBytes: resBytes,
            numTotalTxBytes: txBytes,
        };
    }

    private parseNumber(value: any): number {
        const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
        return isNaN(parsed) ? 0 : parsed;
    }

    private startStaticFileServer(managed: ManagedTunnel): void {
        try {
            const fileServerWorkerPath = path.resolve(__dirname, "../workers/file_serve_worker.js");

            const staticServerWorker = new Worker(fileServerWorkerPath, {
                workerData: {
                    dir: managed.serve,
                    port: managed.tunnelConfig?.forwarding,
                },
            });

            staticServerWorker.on("message", (msg) => {
                switch (msg.type) {
                    case "started":
                        logger.info("Static file server started", { dir: managed.serve });
                        break;

                    case "warning":
                        if (msg.code === "INVALID_TUNNEL_SERVE_PATH") {
                            managed.warnings = managed.warnings ?? [];
                            managed.warnings.push({ code: msg.code, message: msg.message });
                        }
                        CLIPrinter.warn(msg.message);
                        break;

                    case "error":
                        managed.warnings = managed.warnings ?? [];
                        managed.warnings.push({
                            code: "UNKNOWN_WARNING" as TunnelWarningCode,
                            message: msg.message,
                        });
                        break;
                }
            });

            managed.serveWorker = staticServerWorker;
        } catch (error) {
            logger.error("Error starting static file server", error);
        }
    }

}
