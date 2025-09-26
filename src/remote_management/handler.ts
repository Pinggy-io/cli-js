import { ErrorCode, Status, newErrorResponse, ErrorResponse, newStatus, TunnelStateType, TunnelErrorCodeType, newStats } from "../types";
import { ManagedTunnel, TunnelList, TunnelManager } from "../tunnel_manager/TunnelManager";
import { pinggyOptionsToTunnelConfig, tunnelConfigToPinggyOptions, TunnelConfig } from "./remote_schema";
import { PinggyOptions, TunnelUsageType } from "@pinggy/pinggy";

export interface TunnelResponse {
    tunnelid: string,
    remoteurls: string[],
    tunnelconfig: TunnelConfig,
    status: Status,
    stats: TunnelUsageType
}

interface TunnelHandler {
    handleStart(config: TunnelConfig): TunnelResponse | ErrorResponse;
    handleUpdateConfig(config: TunnelConfig): Promise<TunnelResponse | ErrorResponse>;
    handleList(): TunnelResponse[] | ErrorResponse;
    handleStop(tunnelid: string): TunnelResponse | ErrorResponse;
    handleGet(tunnelid: string): TunnelResponse | ErrorResponse;
    handleRestart(tunnelid: string): Promise<TunnelResponse | ErrorResponse>;
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
            const tunnelGreetMsg = this.tunnelManager.getTunnelGreetMessage(tunnelResp.tunnelid);
            const tlsInfo = this.tunnelManager.getLocalserverTlsInfo(tunnelResp.tunnelid);
            // Construct TunnelResponse object
            const tunnelStatus: TunnelResponse = {
                tunnelid: tunnelResp.tunnelid,
                remoteurls: [],
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelPconfig, config.configid, tunnelResp.tunnelName as string, tlsInfo, tunnelGreetMsg as string),
                status: newStatus(this.tunnelManager.getTunnelStatus(tunnelResp.tunnelid) as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: tunnelResp.instance.getLatestUsage() as TunnelUsageType
            };
            return tunnelStatus;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.ErrorStartingTunnel,
                message: error instanceof Error ? error.message : 'Unknown error occurred while starting tunnel'
            });
        }
    }

    async handleUpdateConfig(config: TunnelConfig): Promise<TunnelResponse | ErrorResponse> {
        try {
            // Convert TunnelConfig -> PinggyOptions
            const pinggyOpts = tunnelConfigToPinggyOptions(config);
            const managedTunnel = await this.tunnelManager.updateConfig({ ...pinggyOpts, configid: config.configid, tunnelName: config.configname });
            if (!managedTunnel.tunnelConfig) {
                throw new Error("Failed to update tunnel configuration");
            }
            if (!managedTunnel.instance) {
                throw new Error("Tunnel instance not found after configuration update");
            }

            const tunnelStatus: TunnelResponse = {
                tunnelid: managedTunnel.tunnelid,
                remoteurls: [],
                tunnelconfig: pinggyOptionsToTunnelConfig(managedTunnel.tunnelConfig, config.configid, managedTunnel.tunnelName as string, this.tunnelManager.getLocalserverTlsInfo(managedTunnel.tunnelid), this.tunnelManager.getTunnelGreetMessage(managedTunnel.tunnelid) as string),
                status: newStatus(this.tunnelManager.getTunnelStatus(managedTunnel.tunnelid) as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: managedTunnel.instance.getLatestUsage() as TunnelUsageType
            };
            return tunnelStatus;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.InternalServerError,
                message: error instanceof Error ? error.message : 'Failed to update tunnel configuration'
            });
        }
    }

    handleList(): TunnelResponse[] | ErrorResponse {
        try {
            const tunnels: TunnelList[] = this.tunnelManager.getAllTunnels();
            const result: TunnelResponse[] = tunnels.map(tunnel => {
                // try to get stats from manager first
                const statsFromManager = this.tunnelManager.getTunnelStats(tunnel.tunnelid) as TunnelUsageType | null | undefined;
                let stats: TunnelUsageType | null | undefined = statsFromManager;
                // if null/undefined, return default stats
                if (!stats) {
                    stats = newStats() as TunnelUsageType;
                }

                return {
                    tunnelid: tunnel.tunnelid,
                    remoteurls: tunnel.remoteurls,
                    status: newStatus(this.tunnelManager.getTunnelStatus(tunnel.tunnelid) as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                    stats: stats as TunnelUsageType,
                    // Convert PinggyOptions -> TunnelConfig
                    tunnelconfig: pinggyOptionsToTunnelConfig(this.tunnelManager.getTunnelConfig("", tunnel.tunnelid), tunnel.configid, tunnel.tunnelName as string, this.tunnelManager.getLocalserverTlsInfo(tunnel.tunnelid), this.tunnelManager.getTunnelGreetMessage(tunnel.tunnelid) as string)
                };
            })

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
            const tunnelInstance: ManagedTunnel = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!tunnelInstance) {
                throw new Error(`Tunnel instance for ID "${tunnelid}" not found`);
            }
            if (!tunnelInstance.tunnelConfig) {
                throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            }
            const tunnelResponse: TunnelResponse = {
                tunnelid: stoppedTunnelId,
                remoteurls: [],
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelInstance.tunnelConfig, configid, tunnelInstance.tunnelName as string, this.tunnelManager.getLocalserverTlsInfo(tunnelid), this.tunnelManager.getTunnelGreetMessage(tunnelid) as string),
                status: newStatus(this.tunnelManager.getTunnelStatus(stoppedTunnelId) as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: newStats()
            };
            return tunnelResponse;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to stop tunnel'
            });
        }
    }



    handleGet(tunnelid: string): TunnelResponse | ErrorResponse {
        try {
            const tunnelState: string = this.tunnelManager.getTunnelStatus(tunnelid);
            const tunnelInstance: ManagedTunnel = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!tunnelInstance) {
                throw new Error(`Tunnel instance for ID "${tunnelid}" not found`);
            }
            if (!tunnelInstance.tunnelConfig) {
                throw new Error(`Tunnel config for ID "${tunnelid}" not found`);
            }
            // TODO: directly calling to getLatestUsage() may through error if tunnel stopped earlier
            const stats = this.tunnelManager.getTunnelStats(tunnelid) ? this.tunnelManager.getTunnelStats(tunnelid) : tunnelInstance.instance.getLatestUsage();
            const tunnelResponse: TunnelResponse = {
                tunnelid: tunnelid,
                remoteurls: this.tunnelManager.getTunnelUrls(tunnelid),
                status: newStatus(tunnelState as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: stats as TunnelUsageType,
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelInstance.tunnelConfig, tunnelInstance.configid, tunnelInstance.tunnelName as string, this.tunnelManager.getLocalserverTlsInfo(tunnelid), this.tunnelManager.getTunnelGreetMessage(tunnelid) as string)
            };

            return tunnelResponse;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to get tunnel information'
            });
        }
    }

    async handleRestart(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        try {

            await this.tunnelManager.restartTunnel(tunnelid);

            const tunnelConfig: PinggyOptions = this.tunnelManager.getTunnelConfig("", tunnelid);
            const tunnelInstance: ManagedTunnel = this.tunnelManager.getManagedTunnel("", tunnelid);
            if (!tunnelInstance) {
                throw new Error(`Tunnel instance for ID "${tunnelid}" not found`);
            }
            const stats = this.tunnelManager.getTunnelStats(tunnelid) ? this.tunnelManager.getTunnelStats(tunnelid) : tunnelInstance.instance.getLatestUsage();
            const tunnelResponse: TunnelResponse = {
                tunnelid: tunnelid,
                remoteurls: this.tunnelManager.getTunnelUrls(tunnelid),
                tunnelconfig: pinggyOptionsToTunnelConfig(tunnelConfig, tunnelInstance.configid, tunnelInstance.tunnelName as string, this.tunnelManager.getLocalserverTlsInfo(tunnelid), this.tunnelManager.getTunnelGreetMessage(tunnelid) as string),
                status: newStatus(this.tunnelManager.getTunnelStatus(tunnelid) as TunnelStateType, TunnelErrorCodeType.NoError, ""),
                stats: stats as TunnelUsageType
            };
            return tunnelResponse;
        } catch (error) {
            return newErrorResponse({
                code: ErrorCode.TunnelNotFound,
                message: error instanceof Error ? error.message : 'Failed to restart tunnel'
            });
        }
    }
}
