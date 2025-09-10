import { ResponseObj, NewResponseObject, NewErrorResponseObject, ErrorCode, Status, Stats, newErrorResponse, ErrorResponse, newStatus, TunnelStateType, TunnelErrorCodeType, newStats } from "../types";
import { ManagedTunnel, TunnelList, TunnelManager } from "../tunnel_manager/TunnelManager";
import { pinggyOptionsToTunnelConfig, tunnelConfigToPinggyOptions, TunnelConfig } from "./remote_schema";
import { PinggyOptions } from "@pinggy/pinggy";

export interface TunnelResponse {
    tunnelid: string,
    remoteurls: string[],
    tunnelconfig: TunnelConfig,
    status: Status,
    stats: Stats
}

interface TunnelHandler {
    handleStart(config: TunnelConfig): TunnelResponse | ErrorResponse;
    handleUpdateConfig(config: TunnelConfig): ResponseObj;
    handleList(): TunnelResponse[] | ErrorResponse;
    handleStop(tunnelid: string): TunnelResponse | ErrorResponse;
    handleGet(tunnelid: string): TunnelResponse | ErrorResponse;
    handleRestart(tunnelid: string): TunnelResponse | ErrorResponse;
}

export class TunnelOperations implements TunnelHandler {
    private tunnelManager: TunnelManager;

    constructor() {
        this.tunnelManager = TunnelManager.getInstance();  // Use singleton instance

    }

    handleStart(config: TunnelConfig): TunnelResponse | ErrorResponse {
        try {
            // Convert TunnelConfig -> PinggyOptions
            const pinggyOpts = tunnelConfigToPinggyOptions(config);
            const tunnelResp = this.tunnelManager.createTunnel({ ...pinggyOpts, configid: config.configid, tunnelName: config.configname });

            this.tunnelManager.startTunnel(tunnelResp.tunnelid);
            const tunnelPconfig = this.tunnelManager.getTunnelConfig("", tunnelResp.tunnelid);
            // Construct TunnelResponse object
            const tunnelStatus: TunnelResponse = {
                tunnelid: tunnelResp.tunnelid,
                remoteurls: [],
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelPconfig, config.configid, tunnelResp.tunnelName as string),
                status: newStatus("starting" as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: newStats()
            };
            return tunnelStatus;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.ErrorStartingTunnel,
                message: error instanceof Error ? error.message : 'Unknown error occurred while starting tunnel'
            });
        }
    }

    handleUpdateConfig(config: TunnelConfig): ResponseObj {
        try {
            // Stop existing tunnel if it exists
            const existingTunnel = this.tunnelManager.getTunnelInstance(config.configid);
            if (existingTunnel) {
                this.tunnelManager.stopTunnel(config.configid);
            }
            // Convert TunnelConfig -> PinggyOptions
            const pinggyOpts = tunnelConfigToPinggyOptions(config);
            // Create and start new tunnel with updated config
            const tunnel = this.tunnelManager.createTunnel({ ...pinggyOpts, configid: config.configid });
            const urls = this.tunnelManager.startTunnel(tunnel.tunnelid);
            return NewResponseObject({ tunnelid: tunnel.tunnelid, urls });
        } catch (error) {
            return NewErrorResponseObject({
                code: ErrorCode.InternalServerError,
                message: error instanceof Error ? error.message : 'Failed to update tunnel configuration'
            });
        }
    }

    handleList(): TunnelResponse[] | ErrorResponse {
        try {
            const tunnels: TunnelList[] = this.tunnelManager.getAllTunnels();
            const result: TunnelResponse[] = tunnels.map(tunnel => ({
                tunnelid: tunnel.tunnelid,
                remoteurls: tunnel.remoteurls,
                status: newStatus(this.tunnelManager.getTunnelStatus(tunnel.tunnelid) as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: newStats(),
                // Convert PinggyOptions -> TunnelConfig
                tunnelconfig: pinggyOptionsToTunnelConfig(this.tunnelManager.getTunnelConfig("", tunnel.tunnelid), tunnel.configid, tunnel.tunnelName as string),
            }))
            console.log("List Tunnels Result:", result);
            return result;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.InternalServerError,
                message: error instanceof Error ? error.message : 'Failed to list tunnels'
            });
        }
    }

    handleStop(tunnelid: string): TunnelResponse | ErrorResponse {
        try {
            const { configid, tunnelid: stoppedTunnelId } = this.tunnelManager.stopTunnel(tunnelid);
            const stoppedTunnelInfo: PinggyOptions = this.tunnelManager.getTunnelConfig(tunnelid, "");
            const tunnelInstance: ManagedTunnel = this.tunnelManager.getManagedTunnel(tunnelid);
            if (!tunnelInstance) {
                throw new Error(`Tunnel instance for ID "${tunnelid}" not found`);
            }
            return {
                tunnelid: stoppedTunnelId,
                tunnelconfig: pinggyOptionsToTunnelConfig(stoppedTunnelInfo, configid, tunnelInstance.tunnelName as string),
                remoteurls: [],
                status: newStatus("exited" as TunnelStateType, TunnelErrorCodeType.NoError, "Tunnel stopped successfully"),
                stats: newStats()
            };
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to stop tunnel'
            });
        }
    }

    handleGet(tunnelid: string): TunnelResponse | ErrorResponse {
        try {
            const tunnelConfig: PinggyOptions = this.tunnelManager.getTunnelConfig(tunnelid, "");
            const tunnelState: string = this.tunnelManager.getTunnelStatus(tunnelid);
            const tunnelInstance: ManagedTunnel = this.tunnelManager.getManagedTunnel(tunnelid);
            if (!tunnelInstance) {
                throw new Error(`Tunnel instance for ID "${tunnelid}" not found`);
            }

            return {
                tunnelid: tunnelid,
                remoteurls: this.tunnelManager.getTunnelUrls(tunnelid),
                status: newStatus(tunnelState as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: newStats(),
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelConfig, tunnelInstance.configid, tunnelInstance.tunnelName as string)
            };
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to get tunnel information'
            });
        }
    }

    handleRestart(tunnelid: string): TunnelResponse | ErrorResponse {
        try {
            // Get the current configuration
            this.tunnelManager.restartTunnel(tunnelid);

            const tunnelConfig: PinggyOptions = this.tunnelManager.getTunnelConfig(tunnelid, "");
            const tunnelInstance: ManagedTunnel = this.tunnelManager.getManagedTunnel(tunnelid);
            if (!tunnelInstance) {
                throw new Error(`Tunnel instance for ID "${tunnelid}" not found`);
            }

            return {
                tunnelid: tunnelid,
                remoteurls: this.tunnelManager.getTunnelUrls(tunnelid),
                status: newStatus(this.tunnelManager.getTunnelStatus(tunnelid) as TunnelStateType, TunnelErrorCodeType.NoError, "Tunnel restarted successfully"),
                stats: newStats(),
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelConfig, tunnelInstance.configid, tunnelInstance.tunnelName as string)
            };
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to restart tunnel'
            });
        }
    }
}
