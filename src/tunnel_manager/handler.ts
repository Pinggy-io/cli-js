import { ResponseObj, NewResponseObject, NewErrorResponseObject, ErrorCode, TunnelStatus, Status, Stats, newErrorResponse, ErrorResponse } from "../types";
import { TunnelManager } from "./TunnelManager";
import { pinggyOptionsToTunnelConfig, tunnelConfigToPinggyOptions, TunnelConfig } from "./remote_schema";

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
            const tunnelResp = this.tunnelManager.createTunnel({ ...pinggyOpts, configid: config.configid });

            this.tunnelManager.startTunnel(tunnelResp.tunnelid);
            const tunnelStatus: TunnelResponse = {
                ...tunnelResp.tunnelStatus,
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelResp.tunnelStatus.tunnelconfig)
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
            const tunnels: TunnelStatus[] = this.tunnelManager.getAllTunnelStatuses();
            const result: TunnelResponse[] = tunnels.map(tunnel => ({
                ...tunnel,
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnel.tunnelconfig)
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
            this.tunnelManager.stopTunnel(tunnelid);
            const stoppedTunnelInfo: TunnelStatus = this.tunnelManager.getTunnelStatusByTunnelId(tunnelid);
            return {
                ...stoppedTunnelInfo,
                tunnelconfig: pinggyOptionsToTunnelConfig(stoppedTunnelInfo.tunnelconfig)
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
            const tunnelStatus: TunnelStatus = this.tunnelManager.getTunnelStatusByTunnelId(tunnelid);
            return {
                ...tunnelStatus,
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelStatus.tunnelconfig)
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

            const tunnelStatus: TunnelStatus = this.tunnelManager.getTunnelStatusByTunnelId(tunnelid);
            return {
                ...tunnelStatus,
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelStatus.tunnelconfig)
            };
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to restart tunnel'
            });
        }
    }
}
