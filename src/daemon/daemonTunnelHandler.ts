/**
 * DaemonTunnelHandler: implements TunnelHandler by routing every operation
 * through the daemon's IPC server. Used by remote management when it runs
 * inside the CLI process and needs a TunnelHandler-shaped object.
 */
import { TunnelUsageType } from "@pinggy/pinggy";
import { IPCClient } from "./ipcClient.js";
import { TunnelHandler, TunnelResponse, TunnelResponseV2 } from "../remote_management/handler.js";
import { TunnelConfig, TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { DisconnectListener } from "../tunnel_manager/TunnelManager.js";
import { ErrorResponse } from "../types.js";

export class DaemonTunnelHandler implements TunnelHandler {
    private client: IPCClient;

    constructor(client: IPCClient) {
        this.client = client;
    }

    // methods for v1
    async handleStart(config: TunnelConfig, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        return this.client.startTunnelV1(config, noWait);
    }
    async handleUpdateConfig(config: TunnelConfig, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        return this.client.updateConfig(config, noWait);
    }

    async handleUpdateConfigV2(config: TunnelConfigV1, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse> {
        return this.client.updateConfigV2(config, noWait);
    }

    async handleList(): Promise<TunnelResponse[] | ErrorResponse> {
        return this.client.listTunnelsV1();
    }

    async handleStartV2(config: TunnelConfigV1, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse> {
        return this.client.startTunnelWithConfig(config);
    }

    async handleListV2(): Promise<TunnelResponseV2[] | ErrorResponse> {
        return this.client.listTunnels();
    }

    async handleStop(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        return this.client.stopTunnel(tunnelid);
    }

    async handleGet(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        return this.client.getTunnel(tunnelid);
    }

    async handleRestart(tunnelid: string, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        return this.client.restartTunnel(tunnelid);
    }

    handleRegisterStatsListener(tunnelid: string, listener: (tunnelId: string, stats: TunnelUsageType) => void): void {
        // Stats listeners are handled via WebSocket in TunnelClient, not through this handler.
    }

    handleUnregisterStatsListener(tunnelid: string, listnerId: string): void {
        // No-op in daemon mode
    }

    // Contract stub: TunnelHandler requires a sync return, but stats live in the daemon
    // and can't be fetched synchronously over HTTP. Real stats flow through the WS stats event.
    handleGetTunnelStats(tunnelid: string): TunnelUsageType[] | ErrorResponse {
        return [{ numLiveConnections: 0, numTotalConnections: 0, numTotalReqBytes: 0, numTotalResBytes: 0, numTotalTxBytes: 0, elapsedTime: 0 }];
    }

    handleRegisterDisconnectListener(tunnelid: string, listener: DisconnectListener): void {
        // Disconnect listeners are handled via WebSocket in TunnelClient
    }

    handleRemoveStoppedTunnelByTunnelId(tunnelId: string): boolean | ErrorResponse {
        // Fire and forget — returns a promise but interface expects sync
        this.client.removeStoppedTunnel({ tunnelid: tunnelId });
        return true;
    }

    handleRemoveStoppedTunnelByConfigId(configId: string): boolean | ErrorResponse {
        this.client.removeStoppedTunnel({ configId });
        return true;
    }
}
