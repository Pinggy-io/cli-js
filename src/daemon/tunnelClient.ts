/**
 * TunnelClient: public facade for tunnel operations via the daemon.
 * Used by both CLI and App. Mirrors TunnelOperations interface but routes
 * all operations through the daemon process via HTTP + WebSocket.
 *
 * Composes three helpers:
 *   - IPCClient    : HTTP request/response (start, stop, list, restart, log, …)
 *   - WsStream     : WebSocket lifecycle, per-tunnel subscriptions, event dispatch
 *   - DaemonHealth : heartbeat, reconnect on transient WS drops, daemon-lost events
 */
import { TunnelUsageType } from "@pinggy/pinggy";
import { ClientOrigin, IPCClient } from "./ipc/ipcClient.js";
import { ensureDaemonRunning, getInProcessDaemonHandle } from "./lifecycle/daemonManager.js";
import { TunnelResponse, TunnelResponseV2 } from "../remote_management/handler.js";
import { TunnelConfig, TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { ErrorResponse, isErrorResponse } from "../types.js";
import {
    WsStream,
    SubscriptionMode,
    type StatsCallback,
    type DisconnectCallback,
    type ReconnectingCallback,
    type ReconnectedCallback,
    type ReconnectionFailedCallback,
    type ErrorCallback,
    type UrlReadyCallback,
    type WorkerErrorCallback,
    type WillReconnectCallback,
    type StoppedCallback,
} from "./ws/wsStream.js";
import {
    DaemonHealth,
    type DaemonLostCallback,
    type DaemonReconnectingCallback,
    type DaemonReconnectedCallback,
} from "./daemonHealth.js";
import { DaemonTunnelHandler } from "./daemonTunnelHandler.js";

// Re-exports so external consumers don't need to know about the split.
export { DaemonTunnelHandler } from "./daemonTunnelHandler.js";
export type {
    StatsCallback,
    DisconnectCallback,
    ReconnectingCallback,
    ReconnectedCallback,
    ReconnectionFailedCallback,
    ErrorCallback,
    UrlReadyCallback,
    WorkerErrorCallback,
    WillReconnectCallback,
    StoppedCallback,
} from "./ws/wsStream.js";
export type {
    DaemonLostReason,
    DaemonLostCallback,
    DaemonReconnectingCallback,
    DaemonReconnectedCallback,
} from "./daemonHealth.js";

import { LogPathsResponse, ResolveLogPathResponse, SessionMode } from "./ipc/ipcRoutes.js";

export interface TunnelClientOptions {
    origin?: ClientOrigin;
}

export class TunnelClient {
    private ipc: IPCClient | null = null;
    private origin: ClientOrigin;
    private stream: WsStream;
    health: DaemonHealth;

    constructor(options: TunnelClientOptions = {}) {
        this.origin = options.origin ?? "cli";
        this.stream = new WsStream(() => {
            if (!this.ipc) throw new Error("TunnelClient not initialized. Call ensureDaemon() first.");
            return this.ipc.getWsUrl();
        });
        this.health = new DaemonHealth(() => this.ipc, this.stream);
    }


    async ensureDaemon(): Promise<void> {
        const info = await ensureDaemonRunning();
        this.ipc = new IPCClient(info.port, this.origin);
        this.health.bindPid(info.pid);
        this.health.reset();
    }

    static async forRemoteManagement(): Promise<TunnelClient> {
        const client = new TunnelClient({ origin: "remote" });
        await client.ensureDaemon();
        // Remote management never opens the daemon WebSocket, so the WS-open
        // path that normally starts the heartbeat never fires. Start it here.
        client.health.startHeartbeat();
        return client;
    }

    /**
     * Close the WebSocket connection and cleanup.
     */
    close(): void {
        this.health.stopHeartbeat();
        this.stream.closeNormally();
    }

    async ping(): Promise<{ status: string; pid: number; uptime: number }> {
        this.assertClient();
        return this.ipc!.ping();
    }

    // Tunnel Operations (HTTP)

    // Callers construct config from SDK shapes (FinalConfig) that are
    // structurally compatible with the zod-derived wire type but not nominally
    // identical. Accept the SDK shape and cast at the IPC boundary.
    async handleStartV2(config: object, noWait?: boolean, mode?: SessionMode): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.ipc!.startTunnelWithConfig(config as TunnelConfigV1, mode ?? SessionMode.Detached, noWait);
    }

    async handleStart(config: object, noWait?: boolean, mode?: SessionMode): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.ipc!.startTunnelV1(config as TunnelConfig, mode ?? SessionMode.Detached, noWait);
    }

    async handleUpdateConfig(config: object, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.ipc!.updateConfig(config as TunnelConfig, noWait);
    }

    async handleUpdateConfigV2(config: object, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.ipc!.updateConfigV2(config as TunnelConfigV1, noWait);
    }

    async handleStop(tunnelId: string): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.ipc!.stopTunnel(tunnelId);
    }

    async handleListV2(): Promise<TunnelResponseV2[] | ErrorResponse> {
        this.assertClient();
        return this.ipc!.listTunnels();
    }

    async handleList(): Promise<TunnelResponse[] | ErrorResponse> {
        this.assertClient();
        return this.ipc!.listTunnelsV1();
    }

    handleRemoveStoppedTunnelByTunnelId(tunnelId: string): boolean | ErrorResponse {
        this.assertClient();
        // Fire and forget: TunnelHandler requires sync return; daemon call is async.
        void this.ipc!.removeStoppedTunnel({ tunnelid: tunnelId });
        return true;
    }

    handleRemoveStoppedTunnelByConfigId(configId: string): boolean | ErrorResponse {
        this.assertClient();
        void this.ipc!.removeStoppedTunnel({ configId });
        return true;
    }

    async handleGet(tunnelId: string): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.ipc!.getTunnel(tunnelId);
    }

    async handleRestart(tunnelId: string): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.ipc!.restartTunnel(tunnelId);
    }

    async shutdown(): Promise<void> {
        this.assertClient();
        await this.ipc!.shutdown();
        this.close();
    }

    /**
     * Tear down the daemon hosted in THIS process, if any. Stops all tunnels
     * and removes daemon.json + daemon-state.json so the next CLI run doesn't
     * "crash-recover" tunnels that died with the host application. 
     */
    shutdownInProcessDaemon(): boolean {
        const handle = getInProcessDaemonHandle();
        if (!handle) return false;
        try { this.close(); } catch { /* best effort */ }
        handle.shutdown();
        return true;
    }

    async getLogLevel(): Promise<string> {
        this.assertClient();
        const res = await this.ipc!.getLogLevel();
        return res.level;
    }

    async setLogLevel(level: "debug" | "info" | "error"): Promise<void> {
        this.assertClient();
        await this.ipc!.setLogLevel(level);
    }

    async getTunnelLogging(): Promise<boolean> {
        this.assertClient();
        const res = await this.ipc!.getTunnelLogging();
        return res.enabled;
    }

    async setTunnelLogging(enabled: boolean): Promise<void> {
        this.assertClient();
        await this.ipc!.setTunnelLogging(enabled);
    }

    async getLogPaths(): Promise<LogPathsResponse> {
        this.assertClient();
        return await this.ipc!.getLogPaths() as LogPathsResponse;
    }

    async resolveLogPath(q: string): Promise<ResolveLogPathResponse> {
        this.assertClient();
        return await this.ipc!.resolveLogPath(q) as ResolveLogPathResponse;
    }

    async restart(tunnelId: string): Promise<void> {
        this.assertClient();
        await this.ipc!.restartTunnel(tunnelId);
    }

    // Streaming — delegate to WsStream, guarded by daemon-lost

    async attach(tunnelId: string, mode: SubscriptionMode = SessionMode.Foreground): Promise<void> {
        if (this.health.isLost()) return;
        await this.stream.subscribe(tunnelId, mode);
    }

    detach(tunnelId: string): void {
        const wasSubscribed = this.stream.unsubscribe(tunnelId);
        if (!wasSubscribed) return;
        if (!this.stream.hasSubscriptions()) this.close();
    }

    // Event registration — delegate to WsStream

    onStats(cb: StatsCallback): void { this.stream.onStats(cb); }
    onDisconnect(cb: DisconnectCallback): void { this.stream.onDisconnect(cb); }
    onReconnecting(cb: ReconnectingCallback): void { this.stream.onReconnecting(cb); }
    onReconnected(cb: ReconnectedCallback): void { this.stream.onReconnected(cb); }
    onReconnectionFailed(cb: ReconnectionFailedCallback): void { this.stream.onReconnectionFailed(cb); }
    onError(cb: ErrorCallback): void { this.stream.onError(cb); }
    onUrlReady(cb: UrlReadyCallback): void { this.stream.onUrlReady(cb); }
    onWorkerError(cb: WorkerErrorCallback): void { this.stream.onWorkerError(cb); }
    onWillReconnect(cb: WillReconnectCallback): void { this.stream.onWillReconnect(cb); }
    onStopped(cb: StoppedCallback): void { this.stream.onStopped(cb); }

    // Daemon-loss events — delegate to DaemonHealth

    onDaemonLost(cb: DaemonLostCallback): void { this.health.onLost(cb); }
    onDaemonReconnecting(cb: DaemonReconnectingCallback): void { this.health.onReconnecting(cb); }
    onDaemonReconnected(cb: DaemonReconnectedCallback): void { this.health.onReconnected(cb); }
    isDaemonLost(): boolean { return this.health.isLost(); }

    // App-compat shims (register listener + auto-attach in detached mode)

    handleRegisterStatsListener(tunnelId: string, listener: (tunnelId: string, stats: TunnelUsageType) => void): void {
        this.onStats(listener);
        this.attach(tunnelId, "detached").catch(() => {});
    }

    handleRegisterDisconnectListener(tunnelId: string, listener: (tunnelId: string, error: string, messages: string[]) => void): void {
        this.onDisconnect(listener);
        this.attach(tunnelId, "detached").catch(() => {});
    }

    handleUnregisterStatsListener(_tunnelId: string, _listenerId: string): void {
        // No-op in daemon mode; stats flow over WS push, not registered listeners.
    }

    async handleGetTunnelStats(tunnelId: string): Promise<TunnelUsageType[] | ErrorResponse> {
        this.assertClient();
        return this.ipc!.getTunnelStats(tunnelId);
    }

    // Private

    private assertClient(): void {
        if (!this.ipc) {
            throw new Error("TunnelClient not initialized. Call ensureDaemon() first.");
        }
    }
}
