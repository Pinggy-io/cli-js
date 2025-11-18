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
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { pinggyOptionsToTunnelConfig, tunnelConfigToPinggyOptions, TunnelConfig } from "./remote_schema.js";
import { PinggyOptions, TunnelUsageType } from "@pinggy/pinggy";

export interface TunnelResponse {
    tunnelid: string;
    remoteurls: string[];
    tunnelconfig: TunnelConfig;
    status: Status;
    stats: TunnelUsageType;
}

interface TunnelHandler {
    handleStart(config: TunnelConfig): Promise<TunnelResponse | ErrorResponse>;
    handleUpdateConfig(config: TunnelConfig): Promise<TunnelResponse | ErrorResponse>;
    handleList(): Promise<TunnelResponse[] | ErrorResponse>;
    handleStop(tunnelid: string): Promise<TunnelResponse | ErrorResponse>;
    handleGet(tunnelid: string): Promise<TunnelResponse | ErrorResponse>;
    handleRestart(tunnelid: string): Promise<TunnelResponse | ErrorResponse>;
}

export class TunnelOperations implements TunnelHandler {
     private tunnelManager: TunnelManager;

    constructor() {
        this.tunnelManager = TunnelManager.getInstance();  // Use singleton instance
    }


    // --- Helper to construct TunnelResponse ---
    private async buildTunnelResponse(tunnelid: string, tunnelConfig: PinggyOptions, configid: string, tunnelName: string): Promise<TunnelResponse> {
        const [status, stats, tlsInfo, greetMsg, remoteurls] = await Promise.all([
            this.tunnelManager.getTunnelStatus(tunnelid),
            this.tunnelManager.getTunnelStats(tunnelid) as TunnelUsageType,
            this.tunnelManager.getLocalserverTlsInfo(tunnelid),
            this.tunnelManager.getTunnelGreetMessage(tunnelid),
            this.tunnelManager.getTunnelUrls(tunnelid)
        ]);

        return {
            tunnelid,
            remoteurls,
            tunnelconfig: pinggyOptionsToTunnelConfig(tunnelConfig, configid, tunnelName, tlsInfo, greetMsg as string),
            status: newStatus(status as TunnelStateType, TunnelErrorCodeType.NoError, ""),
            stats
        };
    }

    private error(code: ErrorCodeType, err: unknown, fallback: string): ErrorResponse {
        return newErrorResponse({
            code,
            message: err instanceof Error ? err.message : fallback
        });
    }

    // --- Operations ---
    async handleStart(config: TunnelConfig): Promise<TunnelResponse | ErrorResponse> {
        try {
            // Convert TunnelConfig -> PinggyOptions
            const opts = tunnelConfigToPinggyOptions(config);
            
            const { tunnelid, instance, tunnelName } = await this.tunnelManager.createTunnel({
                ...opts,
                configid: config.configid,
                tunnelName: config.configname
            });

            this.tunnelManager.startTunnel(tunnelid);
            const tunnelPconfig = await this.tunnelManager.getTunnelConfig("", tunnelid);
            const resp =this.buildTunnelResponse(tunnelid, tunnelPconfig, config.configid, tunnelName as string); 
            return resp;
        } catch (err) {
            return this.error(ErrorCode.ErrorStartingTunnel, err, "Unknown error occurred while starting tunnel");
        }
    }

    async handleUpdateConfig(config: TunnelConfig): Promise<TunnelResponse | ErrorResponse> {
        try {
            const opts = tunnelConfigToPinggyOptions(config);
            const tunnel = await this.tunnelManager.updateConfig({
                ...opts,
                configid: config.configid,
                tunnelName: config.configname
            });

            if (!tunnel.instance || !tunnel.tunnelConfig)
                throw new Error("Invalid tunnel state after configuration update");

            return this.buildTunnelResponse(tunnel.tunnelid, tunnel.tunnelConfig, config.configid, tunnel.tunnelName as string);
        } catch (err) {
            return this.error(ErrorCode.InternalServerError, err, "Failed to update tunnel configuration");
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
                    const rawStats = this.tunnelManager.getTunnelStats(t.tunnelid);               
                    const stats = (rawStats ?? newStats()) as TunnelUsageType;
                    const [status,tlsInfo, greetMsg] = await Promise.all([
                        this.tunnelManager.getTunnelStatus(t.tunnelid),
                        this.tunnelManager.getLocalserverTlsInfo(t.tunnelid),
                        this.tunnelManager.getTunnelGreetMessage(t.tunnelid)
                    ]);
                    const tunnelConfig = pinggyOptionsToTunnelConfig(t.tunnelConfig, t.configid, t.tunnelName as string, tlsInfo, greetMsg);

                    return {
                        tunnelid: t.tunnelid,
                        remoteurls: t.remoteurls,
                        status: newStatus(status as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                        stats,
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
            const { configid } = this.tunnelManager.stopTunnel(tunnelid);
            const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            return this.buildTunnelResponse(tunnelid, managed.tunnelConfig, configid, managed.tunnelName as string);
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to stop tunnel");
        }
    }

    async handleGet(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        try {
            const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            return this.buildTunnelResponse(tunnelid, managed.tunnelConfig, managed.configid, managed.tunnelName as string);
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to get tunnel information");
        }
    }

    async handleRestart(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        try {
            await this.tunnelManager.restartTunnel(tunnelid);
            const managed = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!managed?.tunnelConfig) throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            return this.buildTunnelResponse(tunnelid, managed.tunnelConfig, managed.configid, managed.tunnelName as string);
        } catch (err) {
            return this.error(ErrorCode.TunnelNotFound, err, "Failed to restart tunnel");
        }
    }
}
