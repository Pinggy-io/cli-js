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
import { pinggy, type PinggyOptions, type TunnelInstance } from "@pinggy/pinggy";
import { logger } from "../logger";
import { v4 as uuidv4 } from "uuid";
import { AdditionalForwarding } from "../types";


export interface ManagedTunnel {
    tunnelid: string;
    configid: string;
    tunnelName?: string;
    instance: TunnelInstance;
    additionalForwarding?: AdditionalForwarding[];
}

export interface TunnelList {
    tunnelid: string;
    configid: string;
    tunnelName?: string;
    tunnelConfig: PinggyOptions;
    remoteurls: string[];
}

export interface TunnelStats {
    elapsedTime: number;
    numLiveConnections: number;
    numTotalConnections: number;
    numTotalReqBytes: number;
    numTotalResBytes: number;
    numTotalTxBytes: number;
    lastUpdated: Date;
}

export interface ITunnelManager {
    createTunnel(config: (PinggyOptions & { configid: string; tunnelid?: string; tunnelName?: string }) & { additionalForwarding?: AdditionalForwarding[] }): ManagedTunnel;
    startTunnel(tunnelId: string): Promise<string[]>;
    stopTunnel(tunnelId: string): { configid: string; tunnelid: string };
    stopAllTunnels(): void;
    getTunnelUrls(tunnelId: string): string[];
    getAllTunnels(): TunnelList[];
    getTunnelStatus(tunnelId: string): string;
    getTunnelInstance(configId?: string, tunnelId?: string): TunnelInstance;
    getTunnelConfig(configId?: string, tunnelId?: string): PinggyOptions;
    restartTunnel(tunnelId: string): Promise<void>;
    updateConfig(
        tunnelId: string,
        newConfig: PinggyOptions & { configid: string; additionalForwarding?: AdditionalForwarding[] },
        preserveAdditionalForwarding?: boolean
    ): Promise<ManagedTunnel>;
    getManagedTunnel(configId?: string, tunnelId?: string): ManagedTunnel;
    getTunnelGreetMessage(tunnelId: string): string | null;
    getTunnelStats(tunnelId: string): TunnelStats | null;
}

export class TunnelManager implements ITunnelManager {

    private static instance: TunnelManager;
    private tunnelsByTunnelId: Map<string, ManagedTunnel> = new Map();
    private tunnelsByConfigId: Map<string, ManagedTunnel> = new Map();
    private tunnelStats: Map<string, TunnelStats> = new Map();
    private statsCallbacks: Map<string, (stats: Record<string, any>) => void> = new Map();

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
    createTunnel(config: (PinggyOptions & { configid: string; tunnelid?: string; tunnelName?: string }) & { additionalForwarding?: AdditionalForwarding[] }): ManagedTunnel {
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
            additionalForwarding,
        }
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
            logger.debug("Applying additional forwarding rules", managed.additionalForwarding);
            for (const f of managed.additionalForwarding) {
                try {
                    if (!f || !f.remotePort || !f.localDomain || !f.localPort) continue;
                    const hostname = f.remoteDomain && f.remoteDomain.length > 0
                        ? `${f.remoteDomain}:${f.remotePort}`
                        : `${f.remotePort}`;
                    const target = `${f.localDomain}:${f.localPort}`;
                    managed.instance.tunnelRequestAdditionalForwarding(hostname, target);
                    logger.info("Applied additional forwarding", { tunnelId, hostname, target });
                } catch (e) {
                    logger.warn(`Failed to apply additional forwarding (${JSON.stringify(f)}):`, e);
                }
            }
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
            // Support both synchronous and asynchronous stop implementations
            managed.instance.stop();
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
    getTunnelUrls(tunnelId: string): string[] {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        const urls = managed.instance.urls();
        logger.debug("Queried tunnel URLs", { tunnelId, urls });
        return urls;
    }

    /**
     * Get all TunnelStatus currently managed by this TunnelManager
     * @returns An array of all TunnelStatus objects
     */
    getAllTunnels(): TunnelList[] {

        return Array.from(this.tunnelsByTunnelId.values()).map(tunnel => ({
            tunnelid: tunnel.tunnelid,
            configid: tunnel.configid,
            tunnelName: tunnel.tunnelName,
            tunnelConfig: this.getTunnelConfig("", tunnel.tunnelid),
            remoteurls: this.getTunnelUrls(tunnel.tunnelid)
        }));
    }

    /**
     * Get status of a tunnel
     */
    getTunnelStatus(tunnelId: string): string {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        const status = managed.instance.getStatus();
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
    getTunnelConfig(configId: string, tunnelId: string): PinggyOptions {
        if (configId) {
            const tunnelInstance = this.getTunnelInstance(configId, undefined);
            return <PinggyOptions>tunnelInstance.getConfig();
        }
        if (tunnelId) {
            // Correctly fetch by tunnelId (second parameter)
            const tunnelInstance = this.getTunnelInstance(undefined, tunnelId);
            return <PinggyOptions>tunnelInstance.getConfig();
        }
        throw new Error(`Either configId or tunnelId must be provided`);
    }

    /**
     * Restarts a tunnel with its current configuration.
     * This function will stop the tunnel if it's running and start it again.
     * All configurations including additional forwarding rules are preserved.
     */
    async restartTunnel(tunnelId: string): Promise<void> {
        // Get the existing tunnel
        const existingTunnel = this.tunnelsByTunnelId.get(tunnelId);
        if (!existingTunnel) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        logger.info("Initiating tunnel restart", {
            tunnelId,
            configId: existingTunnel.configid
        });

        try {
            // Store the current configuration
            const tunnelId = existingTunnel.tunnelid;
            const currentConfigId = existingTunnel.configid;
            const currentConfig = this.getTunnelConfig("", tunnelId);
            const additionalForwarding = existingTunnel.additionalForwarding;

            // Stop and remove the existing tunnel
            this.tunnelsByTunnelId.delete(tunnelId);
            this.tunnelsByConfigId.delete(existingTunnel.configid);

            // Create a new tunnel with the same configuration
            const newTunnel = this.createTunnel({
                ...currentConfig,
                configid: currentConfigId,
                additionalForwarding
            });

            // Start the new tunnel
            this.startTunnel(newTunnel.tunnelid);

        } catch (error) {
            logger.error("Failed to restart tunnel", {
                tunnelId,
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
        tunnelId: string,
        newConfig: PinggyOptions & { configid: string; additionalForwarding?: AdditionalForwarding[] },
    ): Promise<ManagedTunnel> {

        // Get the existing tunnel
        const existingTunnel = this.tunnelsByTunnelId.get(tunnelId);
        if (!existingTunnel) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        // Store the current state
        const wasRunning = existingTunnel.instance.getStatus() === 'live';
        const currentConfig = this.getTunnelConfig("", tunnelId);
        const existingForwarding = existingTunnel.additionalForwarding;
        const existingTunnelName = existingTunnel.tunnelName;

        try {
            // Stop the existing tunnel if running
            if (wasRunning) {
                existingTunnel.instance.stop();
            }

            // Remove the old tunnel
            this.tunnelsByTunnelId.delete(tunnelId);
            this.tunnelsByConfigId.delete(existingTunnel.configid);

            // Create new tunnel with merged configuration
            const mergedConfig = {
                ...currentConfig,
                ...newConfig,
                configid: existingTunnel.configid,
                tunnelName: (newConfig as any).tunnelName !== undefined ? (newConfig as any).tunnelName : existingTunnelName,
                additionalForwarding: newConfig.additionalForwarding !== undefined ? newConfig.additionalForwarding : existingForwarding
            };

            // Create the new tunnel
            const newTunnel = this.createTunnel(mergedConfig);

            // Start the tunnel if it was running before
            if (wasRunning) {
                await this.startTunnel(newTunnel.tunnelid);
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
                    ...currentConfig,
                    configid: existingTunnel.configid,
                    tunnelName: existingTunnelName,
                    additionalForwarding: existingForwarding
                });
                if (wasRunning) {
                    await this.startTunnel(originalTunnel.tunnelid);
                }
                logger.warn("Restored original tunnel configuration after update failure", {
                    tunnelId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            } catch (restoreError: any) {
                logger.error("Failed to restore original tunnel configuration", {
                    tunnelId,
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

    getTunnelGreetMessage(tunnelId: string): string | null {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        return managed.instance.getGreetMessage();
    }

    getTunnelStats(tunnelId: string): TunnelStats | null {
         const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) {
            throw new Error(`Tunnel "${tunnelId}" not found`);
        }

        // Initialize stats callback if not already set
        this.ensureStatsCallback(tunnelId, managed);

        // Return the latest stats or null if none available yet
        const stats = this.tunnelStats.get(tunnelId);
        return stats || null;
    }

    private ensureStatsCallback(tunnelId: string, managed: ManagedTunnel): void {
        if (this.statsCallbacks.has(tunnelId)) {
            return; // Callback already set up
        }

        try {
            const callback = (usage: Record<string, any>) => {
                try {
                    const normalizedStats = this.normalizeStats(usage);
                    this.tunnelStats.set(tunnelId, normalizedStats);
                    logger.debug("Updated tunnel stats from callback", { tunnelId, stats: normalizedStats });
                } catch (error) {
                    logger.warn("Error processing usage callback data", { tunnelId, error, rawUsage: usage });
                }
            };

            // Set the callback on the tunnel instance
            managed.instance.setUsageUpdateCallback(callback);
            this.statsCallbacks.set(tunnelId, callback);
            
            logger.debug("Successfully set up stats callback", { tunnelId });
            
        } catch (error) {
            logger.warn("Failed to set usage update callback", { tunnelId, error });
        }
    }

    /**
     * Normalizes raw usage data from the SDK into a consistent TunnelStats format.
     */
    private normalizeStats(rawStats: Record<string, any>): TunnelStats {
        const now = new Date();
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
            lastUpdated: now
        };
        }

        private parseNumber(value: any): number {
        const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
        return isNaN(parsed) ? 0 : parsed;
    }

}
