import {
    ErrorCode,
    Status,
    newErrorResponse,
    ErrorResponse,
    newStatus,
    TunnelStateType,
    TunnelErrorCodeType,
    newStats,
    ErrorCodeType
} from "../types.js";
import { logger } from "../logger.js";
import { DisconnectListener, TunnelManager, TunnelOrigin } from "../tunnel_manager/TunnelManager.js";
import { pinggyOptionsToTunnelConfig, tunnelConfigToPinggyOptions, TunnelConfig, TunnelConfigV1, pinggyOptionsToTunnelConfigV1 } from "./remote_schema.js";
import { TunnelConfigurationV1, TunnelUsageType } from "@pinggy/pinggy";

export interface TunnelResponse {
    tunnelid: string;
    remoteurls: string[];
    tunnelconfig: TunnelConfig;
    status: Status;
    stats: TunnelUsageType;
}

export interface TunnelResponseV2 {
    tunnelid: string;
    remoteurls: string[];
    tunnelconfig: TunnelConfigV1;
    status: Status;
    stats: TunnelUsageType;
    greetmsg?: string;
}

export interface TunnelHandler {
    handleStart(config: TunnelConfig, noWait?: boolean): Promise<TunnelResponse | ErrorResponse>;
    handleStartV2(config: TunnelConfigV1, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse>;
    handleUpdateConfig(config: TunnelConfig, noWait?: boolean): Promise<TunnelResponse | ErrorResponse>;
    handleUpdateConfigV2(config: TunnelConfigV1, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse>;
    handleList(): Promise<TunnelResponse[] | ErrorResponse>;
    handleListV2(): Promise<TunnelResponseV2[] | ErrorResponse>;
    handleStop(tunnelid: string): Promise<TunnelResponse | ErrorResponse>;
    handleGet(tunnelid: string): Promise<TunnelResponse | ErrorResponse>;
    handleRestart(tunnelid: string, noWait?: boolean): Promise<TunnelResponse | ErrorResponse>;
    handleRegisterStatsListener(tunnelid: string, listener: (tunnelId: string, stats: TunnelUsageType) => void): void;
    handleUnregisterStatsListener(tunnelid: string, listnerId: string): void;
    handleGetTunnelStats(tunnelid: string): TunnelUsageType[] | ErrorResponse;
    handleRegisterDisconnectListener(tunnelid: string, listener: DisconnectListener): void;
    handleRemoveStoppedTunnelByTunnelId(tunnelId: string): boolean | ErrorResponse;
    handleRemoveStoppedTunnelByConfigId(configId: string): boolean | ErrorResponse;
}

export class TunnelOperations implements TunnelHandler {
    private tunnelManager: TunnelManager;

    constructor() {
        this.tunnelManager = TunnelManager.getInstance();  // Use singleton instance
    }


    private buildStatus(tunnelId: string, state: TunnelStateType, errorCode: TunnelErrorCodeType): Status {
        const status = newStatus(state, errorCode, "");
        try {
            const managed = this.tunnelManager.getManagedTunnel("", tunnelId);
            if (managed) {
                status.createdtimestamp = managed.createdAt || "";
                status.starttimestamp = managed.startedAt || "";
                status.endtimestamp = managed.stoppedAt || "";
            }
            if(managed?.lastError) {
                status.lastError = managed.lastError;
            }
        } catch (e) {
            //ignore
        }
        return status;
    }

    // --- Placeholder response ---
    private buildPendingTunnelResponse(tunnelid: string, tunnelConfig: TunnelConfigurationV1, configid: string, tunnelName: string, serve?: string): TunnelResponse {
        return {
            tunnelid,
            remoteurls: [],
            tunnelconfig: pinggyOptionsToTunnelConfig(tunnelConfig, configid, tunnelName, false, undefined, serve),
            status: this.buildStatus(tunnelid, TunnelStateType.Starting, TunnelErrorCodeType.NoError),
            stats: newStats()
        };
    }

    private buildPendingTunnelResponseV2(tunnelid: string, tunnelConfig: TunnelConfigurationV1, configFromCli: TunnelConfigurationV1, configid: string, tunnelName: string, serve?: string): TunnelResponseV2 {
        return {
            tunnelid,
            remoteurls: [],
            tunnelconfig: pinggyOptionsToTunnelConfigV1(tunnelConfig, configFromCli),
            status: this.buildStatus(tunnelid, TunnelStateType.Starting, TunnelErrorCodeType.NoError),
            stats: newStats(),
            greetmsg: ""
        };
    }

    // --- Helper to construct TunnelResponse ---
    private async buildTunnelResponse(tunnelid: string, tunnelConfig: TunnelConfigurationV1, configid: string, tunnelName: string, serve?: string): Promise<TunnelResponse> {
        const [status, stats, tlsInfo, greetMsg, remoteurls] = await Promise.all([
            this.tunnelManager.getTunnelStatus(tunnelid),
            this.tunnelManager.getLatestTunnelStats(tunnelid) || newStats(),
            this.tunnelManager.getLocalserverTlsInfo(tunnelid),
            this.tunnelManager.getTunnelGreetMessage(tunnelid),
            this.tunnelManager.getTunnelUrls(tunnelid)
        ]);

        return {
            tunnelid,
            remoteurls,
            tunnelconfig: pinggyOptionsToTunnelConfig(tunnelConfig, configid, tunnelName, tlsInfo, greetMsg as string),
            status: this.buildStatus(tunnelid, status as TunnelStateType, TunnelErrorCodeType.NoError),
            stats
        };
    }

    private async buildTunnelResponseV2(tunnelid: string, tunnelConfig: TunnelConfigurationV1, configFromCli: TunnelConfigurationV1,
         configid: string, tunnelName: string, serve?: string): Promise<TunnelResponseV2> {
        const [status, stats, greetMsg, remoteurls] = await Promise.all([
            this.tunnelManager.getTunnelStatus(tunnelid),
            this.tunnelManager.getLatestTunnelStats(tunnelid) || newStats(),
            this.tunnelManager.getTunnelGreetMessage(tunnelid),
            this.tunnelManager.getTunnelUrls(tunnelid)
        ]);

        return {
            tunnelid,
            remoteurls,
            tunnelconfig: pinggyOptionsToTunnelConfigV1(tunnelConfig, configFromCli),
            status: this.buildStatus(tunnelid, status as TunnelStateType, TunnelErrorCodeType.NoError),
            stats,
            greetmsg: greetMsg as string
        };
    }

    private error(code: ErrorCodeType, err: unknown, fallback: string): ErrorResponse {
        return newErrorResponse({
            code,
            message: err instanceof Error ? err.message : fallback
        });
    }

    // --- Operations ---
    async handleStart(config: TunnelConfig, noWait = false, origin: TunnelOrigin = "cli"): Promise<TunnelResponse | ErrorResponse> {
        try {
            // Convert TunnelConfig -> PinggyOptions
            const opts = tunnelConfigToPinggyOptions(config);
            const managed = await this.tunnelManager.createTunnel({
                ...opts,
                configId: config.configid,
                name: config.configname,
                optional:{
                    serve: config.serve,
                }
            }, origin);
            const { tunnelid, tunnelName, serve, tunnelConfig } = managed;

            const startPromise = this.tunnelManager.startTunnel(tunnelid);

            if (noWait) {
                startPromise.catch(err => {
                    logger.error("No-wait startTunnel failed", { tunnelid, err: String(err) });
                });
                return this.buildPendingTunnelResponse(tunnelid, tunnelConfig!, config.configid, tunnelName as string, serve);
            }

            await startPromise;
            const tunnelPconfig = await this.tunnelManager.getTunnelConfig("", tunnelid);
            return this.buildTunnelResponse(tunnelid, tunnelPconfig, config.configid, tunnelName as string, serve);
        } catch (err) {
            return this.error(ErrorCode.ErrorStartingTunnel, err, "Unknown error occurred while starting tunnel");
        }
    }

    async handleStartV2(config: TunnelConfigV1, noWait = false, origin: TunnelOrigin = "cli"): Promise<TunnelResponseV2 | ErrorResponse> {
        try {
            // Convert TunnelConfigV1 -> PinggyOptions
            const managed = await this.tunnelManager.createTunnel(config, origin);
            const { tunnelid, serve, tunnelConfig } = managed;

            await this.tunnelManager.startTunnel(tunnelid);
          

            const tunnelPconfig = await this.tunnelManager.getTunnelConfig("", tunnelid);
            return this.buildTunnelResponseV2(tunnelid, tunnelPconfig, config, config.configId, config.name, config.serve);
        } catch (err) {
            return this.error(ErrorCode.ErrorStartingTunnel, err, "Unknown error occurred while starting tunnel");
        }
    }

    async handleUpdateConfig(config: TunnelConfig, noWait = false): Promise<TunnelResponse | ErrorResponse> {
        try {
            const opts = tunnelConfigToPinggyOptions(config);
            const updateOpts = {
                ...opts,
                configId: config.configid,
                name: config.configname,
                optional:{
                    serve: config.serve,
                }
            };

            if (noWait) {
                const existing = this.tunnelManager.getManagedTunnel(config.configid);
                if (!existing.tunnelConfig) throw new Error("Invalid tunnel state before configuration update");
                this.tunnelManager.updateConfig(updateOpts).catch(err => {
                    logger.error("No-wait updateConfig failed", { configid: config.configid, err: String(err) });
                });
                return this.buildPendingTunnelResponse(existing.tunnelid, existing.tunnelConfig, config.configid, existing.tunnelName as string, existing.serve);
            }

            const tunnel = await this.tunnelManager.updateConfig(updateOpts);

            if (!tunnel.instance || !tunnel.tunnelConfig)
                throw new Error("Invalid tunnel state after configuration update");

            return this.buildTunnelResponse(tunnel.tunnelid, tunnel.tunnelConfig, config.configid, tunnel.tunnelName as string, tunnel.serve);
        } catch (err) {
            return this.error(ErrorCode.InternalServerError, err, "Failed to update tunnel configuration");
        }
    }

    async handleUpdateConfigV2(config: TunnelConfigV1, noWait = false): Promise<TunnelResponseV2 | ErrorResponse> {
        try {
            if (noWait) {
                const existing = this.tunnelManager.getManagedTunnel(config.configId);
                console.log(existing);
                if (!existing.tunnelConfig) throw new Error("Invalid tunnel state before configuration update");
                this.tunnelManager.updateConfig(config).catch(err => {
                    logger.error("No-wait updateConfigV2 failed", { configId: config.configId, err: String(err) });
                });
                return this.buildPendingTunnelResponseV2(existing.tunnelid, existing.tunnelConfig, config, config.configId, existing.tunnelName as string, existing.serve);
            }

            const tunnel = await this.tunnelManager.updateConfig(config);

            if (!tunnel.instance || !tunnel.tunnelConfig)
                throw new Error("Invalid tunnel state after configuration update");

            return this.buildTunnelResponseV2(tunnel.tunnelid, tunnel.tunnelConfig, config, config.configId, tunnel.tunnelName as string, tunnel.serve);
        } catch (err) {
            return this.error(ErrorCode.InternalServerError, err, "Failed to update tunnel configuration");
        }
    }

    async handleListV2(): Promise<TunnelResponseV2[] | ErrorResponse> {

        try {
            const tunnels = await this.tunnelManager.getAllTunnels();
            if (tunnels.length === 0) {
                return [];
            }
         
            return Promise.all(
                tunnels.map(async (t) => {
                  
                    const rawStats = this.tunnelManager.getLatestTunnelStats(t.tunnelid) || newStats();
                    const [status, tlsInfo, greetMsg] = await Promise.all([
                        this.tunnelManager.getTunnelStatus(t.tunnelid),
                        this.tunnelManager.getLocalserverTlsInfo(t.tunnelid),
                        this.tunnelManager.getTunnelGreetMessage(t.tunnelid)
                    ]);
                    const tunnelConfguration = status !== TunnelStateType.Closed && status !== TunnelStateType.Exited
                        ? await this.tunnelManager.getTunnelConfig("", t.tunnelid)
                        : t.tunnelConfig!;
                    const tunnelConfig = pinggyOptionsToTunnelConfigV1(tunnelConfguration, t.tunnelConfig);
                 
                    
                    return {
                        tunnelid: t.tunnelid,
                        remoteurls: t.remoteurls,
                        status: this.buildStatus(t.tunnelid, status as TunnelStateType, TunnelErrorCodeType.NoError),
                        stats: rawStats,
                        tunnelconfig: tunnelConfig,
                        greetmsg: greetMsg as string
                    };
                })
            );
        } catch (err) {
            return this.error(ErrorCode.InternalServerError, err, "Failed to list tunnels");
        }
    }
    async handleList(): Promise<TunnelResponse[] | ErrorResponse> {

        try {
            const tunnels = await this.tunnelManager.getAllTunnels();
            if (tunnels.length === 0) {
                return [];
            }
            return Promise.all(
                tunnels.map(async (t) => {
                    const rawStats = this.tunnelManager.getLatestTunnelStats(t.tunnelid) || newStats();
                    const [status, tlsInfo, greetMsg] = await Promise.all([
                        this.tunnelManager.getTunnelStatus(t.tunnelid),
                        this.tunnelManager.getLocalserverTlsInfo(t.tunnelid),
                        this.tunnelManager.getTunnelGreetMessage(t.tunnelid)
                    ]);
                    const pinggyOptions = status !== TunnelStateType.Closed && status !== TunnelStateType.Exited
                        ? await this.tunnelManager.getTunnelConfig("", t.tunnelid)
                        : t.tunnelConfig!;
                    const tunnelConfig = pinggyOptionsToTunnelConfig(pinggyOptions, t.configId, t.tunnelName as string, tlsInfo, greetMsg, t.serve);

                    return {
                        tunnelid: t.tunnelid,
                        remoteurls: t.remoteurls,
                        status: this.buildStatus(t.tunnelid, status as TunnelStateType, TunnelErrorCodeType.NoError),
                        stats: rawStats,
                        tunnelconfig: tunnelConfig
                    };
                })
            );
        } catch (err) {
            return this.error(ErrorCode.InternalServerError, err, "Failed to list tunnels");
        }
    }

    async handleStop(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        try {
            const { configId } = this.tunnelManager.stopTunnel(tunnelid);
            const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            return this.buildTunnelResponse(tunnelid, managed.tunnelConfig, configId, managed.tunnelName as string, managed.serve);
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to stop tunnel");
        }
    }

    async handleGet(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        try {
            const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            return this.buildTunnelResponse(tunnelid, managed.tunnelConfig, managed.configId, managed.tunnelName as string, managed.serve);
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to get tunnel information");
        }
    }

    async handleRestart(tunnelid: string, noWait = false): Promise<TunnelResponse | ErrorResponse> {
        try {
            if (noWait) {
                const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
                if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
                this.tunnelManager.restartTunnel(tunnelid).catch(err => {
                    logger.error("No-wait restartTunnel failed", { tunnelid, err: String(err) });
                });
                return this.buildPendingTunnelResponse(tunnelid, managed.tunnelConfig, managed.configId, managed.tunnelName as string, managed.serve);
            }

            await this.tunnelManager.restartTunnel(tunnelid);
            const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            return this.buildTunnelResponse(tunnelid, managed.tunnelConfig, managed.configId, managed.tunnelName as string, managed.serve);
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to restart tunnel");
        }
    }
    handleRegisterStatsListener(tunnelid: string, listener: (tunnelId: string, stats: TunnelUsageType) => void): void {
        this.tunnelManager.registerStatsListener(tunnelid, listener);
    }

    handleUnregisterStatsListener(tunnelid: string, listnerId: string): void {
        this.tunnelManager.deregisterStatsListener(tunnelid, listnerId);
    }

    handleGetTunnelStats(tunnelid: string): TunnelUsageType[] | ErrorResponse {
        try {
            const stats = this.tunnelManager.getTunnelStats(tunnelid);
            if (!stats) {
                // if no stats found, return new stats object
                return [newStats()];
            }
            return stats;
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to get tunnel stats");
        }
    }

    handleRegisterDisconnectListener(tunnelid: string, listener: DisconnectListener): void {
        this.tunnelManager.registerDisconnectListener(tunnelid, listener);
    }

    handleRemoveStoppedTunnelByConfigId(configId: string): boolean | ErrorResponse {
        try {
            return this.tunnelManager.removeStoppedTunnelByConfigId(configId);
        } catch (err) {

            return this.error(ErrorCode.InternalServerError, err, "Failed to remove stopped tunnel by configId");
        }
    }

    handleRemoveStoppedTunnelByTunnelId(tunnelId: string): boolean | ErrorResponse {
        try {
            return this.tunnelManager.removeStoppedTunnelByTunnelId(tunnelId);
        } catch (err) {

            return this.error(ErrorCode.InternalServerError, err, "Failed to remove stopped tunnel by tunnelId");
        }
    }
}
