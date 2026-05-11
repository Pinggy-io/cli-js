/**
 * TunnelClient — public facade for tunnel operations via the daemon.
 * Used by both CLI and App. Mirrors TunnelOperations interface but routes
 * all operations through the daemon process via HTTP + WebSocket.
 *
 * Responsibilities:
 * - Ensure daemon is running (spawn if needed)
 * - HTTP calls for request/response operations (start, stop, list, get, restart)
 * - WebSocket connection for real-time event streaming
 * - Event callback registration proxied from WS stream
 */
import { WebSocket } from "ws";
import { TunnelUsageType } from "@pinggy/pinggy";
import { IPCClient } from "./ipcClient.js";
import { getDaemonInfo, startDaemon } from "./daemonManager.js";
import { TunnelHandler, TunnelResponse, TunnelResponseV2 } from "../remote_management/handler.js";
import { TunnelConfig, TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { DisconnectListener } from "../tunnel_manager/TunnelManager.js";
import { ErrorResponse, isErrorResponse } from "../types.js";
import { logger } from "../logger.js";
import {
    ClientMessage,
    TunnelEvent,
    TunnelEventPayloadMap,
} from "./wsProtocol.js";

// Types

export type StatsCallback = (tunnelId: string, stats: TunnelUsageType) => void;
export type DisconnectCallback = (tunnelId: string, error: string, messages: string[]) => void;
export type ReconnectingCallback = (tunnelId: string, retryCnt: number) => void;
export type ReconnectedCallback = (tunnelId: string, urls: string[]) => void;
export type ReconnectionFailedCallback = (tunnelId: string, retryCnt: number) => void;
export type ErrorCallback = (tunnelId: string, message: string, isFatal: boolean) => void;
export type UrlReadyCallback = (tunnelId: string, urls: string[]) => void;
export type WorkerErrorCallback = (tunnelId: string, message: string) => void;
export type WillReconnectCallback = (tunnelId: string, error: string, messages: string[]) => void;
export type StoppedCallback = (tunnelId: string) => void;

interface EventCallbacks {
    stats: StatsCallback[];
    disconnect: DisconnectCallback[];
    reconnecting: ReconnectingCallback[];
    reconnected: ReconnectedCallback[];
    reconnection_failed: ReconnectionFailedCallback[];
    error: ErrorCallback[];
    url_ready: UrlReadyCallback[];
    worker_error: WorkerErrorCallback[];
    will_reconnect: WillReconnectCallback[];
    stopped: StoppedCallback[];
}

// TunnelClient

export class TunnelClient {
    private client: IPCClient | null = null;
    private ws: WebSocket | null = null;
    private callbacks: EventCallbacks = {
        stats: [],
        disconnect: [],
        reconnecting: [],
        reconnected: [],
        reconnection_failed: [],
        error: [],
        url_ready: [],
        worker_error: [],
        will_reconnect: [],
        stopped: [],
    };
    private subscribedTunnels: Set<string> = new Set();
    private wsReady: Promise<void> | null = null;
    private wsResolve: (() => void) | null = null;

    // Lifecycle

    /**
     * Ensure the daemon is running. Spawns it if not.
     * Must be called before any operations.
     */
    async ensureDaemon(): Promise<void> {
        const info = getDaemonInfo();
        if (info) {
            this.client = new IPCClient(info.port);
            return;
        }

        const daemonInfo = await startDaemon();
        this.client = new IPCClient(daemonInfo.port);
    }

    /**
     * Close the WebSocket connection and cleanup.
     */
    close(): void {
        if (this.ws) {
            this.ws.close(1000, "Client closing");
            this.ws = null;
        }
        this.subscribedTunnels.clear();
        this.wsReady = null;
        this.wsResolve = null;
    }

    /**
     * Check if daemon is currently reachable.
     */
    async ping(): Promise<{ status: string; pid: number; uptime: number }> {
        this.assertClient();
        return this.client!.ping();
    }

    // Tunnel Operations (HTTP)

    /**
     * Start a tunnel by saved config name.
     */
    async startByName(name: string): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.client!.startTunnel(name);
    }

    /**
     * Start a tunnel from inline config (ad-hoc or from app).
     * Compatible with TunnelOperations.handleStartV2 interface.
     */
    async handleStartV2(config: object): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.client!.startTunnelWithConfig(config);
    }

    /**
     * Stop a tunnel by ID.
     * Compatible with TunnelOperations.handleStop interface.
     */
    async handleStop(tunnelId: string): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.client!.stopTunnel(tunnelId);
    }

    /**
     * List all running tunnels.
     * Compatible with TunnelOperations.handleListV2 interface.
     */
    async handleListV2(): Promise<TunnelResponseV2[] | ErrorResponse> {
        this.assertClient();
        return this.client!.listTunnels();
    }

    /**
     * Get a single tunnel by ID.
     */
    async handleGet(tunnelId: string): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.client!.getTunnel(tunnelId);
    }

    /**
     * Restart a tunnel.
     * Compatible with TunnelOperations.handleRestart interface.
     */
    async handleRestart(tunnelId: string): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.client!.restartTunnel(tunnelId);
    }

    /**
     * Shutdown the daemon entirely.
     */
    async shutdown(): Promise<void> {
        this.assertClient();
        await this.client!.shutdown();
        this.close();
    }

    // Streaming (WebSocket)

    /**
     * Attach to a tunnel's event stream via WebSocket.
     * Opens WS connection if not already open, subscribes to tunnel events.
     */
    async attach(tunnelId: string, mode: "foreground" | "detached" = "foreground"): Promise<void> {
        await this.ensureWsConnection();
        await this.wsReady;

        if (this.subscribedTunnels.has(tunnelId)) {
            return; // Already subscribed
        }

        const msg: ClientMessage = { type: "subscribe", tunnelId, mode };
        this.ws!.send(JSON.stringify(msg));
        this.subscribedTunnels.add(tunnelId);
    }

    /**
     * Detach from a tunnel's event stream.
     * Does NOT close the WS connection (other tunnels may be subscribed).
     */
    detach(tunnelId: string): void {
        if (!this.ws || !this.subscribedTunnels.has(tunnelId)) return;

        const msg: ClientMessage = { type: "unsubscribe", tunnelId };
        this.ws.send(JSON.stringify(msg));
        this.subscribedTunnels.delete(tunnelId);

        // Close WS if no more subscriptions
        if (this.subscribedTunnels.size === 0) {
            this.close();
        }
    }

    // Event Registration

    onStats(cb: StatsCallback): void {
        this.callbacks.stats.push(cb);
    }

    onDisconnect(cb: DisconnectCallback): void {
        this.callbacks.disconnect.push(cb);
    }

    onReconnecting(cb: ReconnectingCallback): void {
        this.callbacks.reconnecting.push(cb);
    }

    onReconnected(cb: ReconnectedCallback): void {
        this.callbacks.reconnected.push(cb);
    }

    onReconnectionFailed(cb: ReconnectionFailedCallback): void {
        this.callbacks.reconnection_failed.push(cb);
    }

    onError(cb: ErrorCallback): void {
        this.callbacks.error.push(cb);
    }

    onUrlReady(cb: UrlReadyCallback): void {
        this.callbacks.url_ready.push(cb);
    }

    onWorkerError(cb: WorkerErrorCallback): void {
        this.callbacks.worker_error.push(cb);
    }

    onWillReconnect(cb: WillReconnectCallback): void {
        this.callbacks.will_reconnect.push(cb);
    }

    onStopped(cb: StoppedCallback): void {
        this.callbacks.stopped.push(cb);
    }

    /**
     * Register stats listener (app compatibility).
     * Same as onStats but with TunnelOperations-style signature.
     */
    handleRegisterStatsListener(tunnelId: string, listener: (tunnelId: string, stats: TunnelUsageType) => void): void {
        this.onStats(listener);
        // Auto-attach if not already subscribed
        this.attach(tunnelId, "detached").catch(() => {});
    }

    /**
     * Register disconnect listener (app compatibility).
     */
    handleRegisterDisconnectListener(tunnelId: string, listener: (tunnelId: string, error: string, messages: string[]) => void): void {
        this.onDisconnect(listener);
        this.attach(tunnelId, "detached").catch(() => {});
    }

    /**
     * Get tunnel stats (app compatibility — returns from last received stats event).
     * For real-time stats, use onStats callback instead.
     */
    handleGetTunnelStats(tunnelId: string): TunnelUsageType[] | ErrorResponse {
        // This is a limitation — we can't synchronously return stats from daemon.
        // For the app, it should switch to the callback pattern.
        // For now, return empty stats.
        return [{ numLiveConnections: 0, numTotalConnections: 0, numTotalReqBytes: 0, numTotalResBytes: 0, numTotalTxBytes: 0, elapsedTime: 0 }];
    }

    // Private

    private assertClient(): void {
        if (!this.client) {
            throw new Error("TunnelClient not initialized. Call ensureDaemon() first.");
        }
    }

    private async ensureWsConnection(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        this.assertClient();
        const wsUrl = this.client!.getWsUrl();

        this.wsReady = new Promise<void>((resolve) => {
            this.wsResolve = resolve;
        });

        this.ws = new WebSocket(wsUrl);

        this.ws.on("open", () => {
            if (this.wsResolve) {
                this.wsResolve();
                this.wsResolve = null;
            }
        });

        this.ws.on("message", (data) => {
            this.handleWsMessage(data.toString());
        });

        this.ws.on("close", () => {
            this.ws = null;
            this.subscribedTunnels.clear();
            this.wsReady = null;
        });

        this.ws.on("error", (err) => {
            logger.error("TunnelClient WS error", { error: err.message });
        });
    }

    private handleWsMessage(raw: string): void {
        try {
            const msg = JSON.parse(raw) as TunnelEvent;
            if (msg.type !== "tunnel_event") return;

            const { tunnelId, event, payload } = msg;

            switch (event) {
                case "stats":
                    for (const cb of this.callbacks.stats) {
                        cb(tunnelId, (payload as TunnelEventPayloadMap["stats"]).stats);
                    }
                    break;
                case "disconnect":
                    for (const cb of this.callbacks.disconnect) {
                        const p = payload as TunnelEventPayloadMap["disconnect"];
                        cb(tunnelId, p.error, p.messages);
                    }
                    break;
                case "reconnecting":
                    for (const cb of this.callbacks.reconnecting) {
                        cb(tunnelId, (payload as TunnelEventPayloadMap["reconnecting"]).retryCnt);
                    }
                    break;
                case "reconnected":
                    for (const cb of this.callbacks.reconnected) {
                        cb(tunnelId, (payload as TunnelEventPayloadMap["reconnected"]).urls);
                    }
                    break;
                case "reconnection_failed":
                    for (const cb of this.callbacks.reconnection_failed) {
                        cb(tunnelId, (payload as TunnelEventPayloadMap["reconnection_failed"]).retryCnt);
                    }
                    break;
                case "error":
                    for (const cb of this.callbacks.error) {
                        const p = payload as TunnelEventPayloadMap["error"];
                        cb(tunnelId, p.message, p.isFatal);
                    }
                    break;
                case "url_ready":
                    for (const cb of this.callbacks.url_ready) {
                        cb(tunnelId, (payload as TunnelEventPayloadMap["url_ready"]).urls);
                    }
                    break;
                case "worker_error":
                    for (const cb of this.callbacks.worker_error) {
                        cb(tunnelId, (payload as TunnelEventPayloadMap["worker_error"]).message);
                    }
                    break;
                case "will_reconnect":
                    for (const cb of this.callbacks.will_reconnect) {
                        const p = payload as TunnelEventPayloadMap["will_reconnect"];
                        cb(tunnelId, p.error, p.messages);
                    }
                    break;
                case "stopped":
                    for (const cb of this.callbacks.stopped) {
                        cb(tunnelId);
                    }
                    break;
            }
        } catch {
            // Ignore malformed messages
        }
    }
}

// DaemonTunnelHandler
// Implements TunnelHandler by routing all operations through the daemon via IPC.
// Used by remote management when running in the CLI process.

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
        // Remote management printer uses this for monitoring but it's not critical.
    }

    handleUnregisterStatsListener(tunnelid: string, listnerId: string): void {
        // No-op in daemon mode
    }

    handleGetTunnelStats(tunnelid: string): TunnelUsageType[] | ErrorResponse {
        return [{ numLiveConnections: 0, numTotalConnections: 0, numTotalReqBytes: 0, numTotalResBytes: 0, numTotalTxBytes: 0, elapsedTime: 0 }];
    }

    handleRegisterDisconnectListener(tunnelid: string, listener: DisconnectListener): void {
        // Disconnect listeners are handled via WebSocket in TunnelClient
    }

    handleRemoveStoppedTunnelByTunnelId(tunnelId: string): boolean | ErrorResponse {
        // Fire and forget - returns a promise but interface expects sync
        this.client.removeStoppedTunnel({ tunnelid: tunnelId });
        return true;
    }

    handleRemoveStoppedTunnelByConfigId(configId: string): boolean | ErrorResponse {
        this.client.removeStoppedTunnel({ configId });
        return true;
    }
}
