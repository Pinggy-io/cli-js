/**
 * TunnelClient: public facade for tunnel operations via the daemon.
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
import { ClientOrigin, IPCClient } from "./ipcClient.js";
import { ensureDaemonRunning, getDaemonInfo } from "./daemonManager.js";
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

// Daemon-loss detection tuning. Kept as constants — these aren't user-tunable.
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 2000;
const HEARTBEAT_FAILURE_THRESHOLD = 2;
const WS_NORMAL_CLOSE = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export type DaemonLostReason = "dead" | "respawned" | "hung" | "heartbeat";
export type DaemonLostCallback = (reason: DaemonLostReason, detail?: string) => void;
export type DaemonReconnectingCallback = (attempt: number, max: number) => void;
export type DaemonReconnectedCallback = () => void;

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

export interface TunnelClientOptions {
    origin?: ClientOrigin;
}

export class TunnelClient {
    private client: IPCClient | null = null;
    private origin: ClientOrigin;
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
    // Subscribed tunnels keep their mode so we can re-subscribe after a transient WS drop.
    private subscribedTunnels: Map<string, { mode: "foreground" | "detached" }> = new Map();
    private wsReady: Promise<void> | null = null;
    private wsResolve: (() => void) | null = null;

    // Daemon-loss tracking
    private originalDaemonPid: number | null = null;
    private daemonLost = false;
    private reconnecting = false;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private daemonLostCallbacks: DaemonLostCallback[] = [];
    private daemonReconnectingCallbacks: DaemonReconnectingCallback[] = [];
    private daemonReconnectedCallbacks: DaemonReconnectedCallback[] = [];

    constructor(options: TunnelClientOptions = {}) {
        this.origin = options.origin ?? "cli";
    }

    // Lifecycle

    /**
     * Ensure the daemon is running. Spawns it if not.
     * Must be called before any operations.
     */
    async ensureDaemon(): Promise<void> {
        const info = await ensureDaemonRunning();
        this.originalDaemonPid = info.pid;
        this.client = new IPCClient(info.port, this.origin);
    }

    static async forRemoteManagement(): Promise<DaemonTunnelHandler> {
        const info = await ensureDaemonRunning();
        return new DaemonTunnelHandler(new IPCClient(info.port, "remote"));
    }

    /**
     * Close the WebSocket connection and cleanup.
     */
    close(): void {
        this.stopHeartbeat();
        if (this.ws) {
            try { this.ws.close(WS_NORMAL_CLOSE, "Client closing"); } catch { /* socket may already be dead */ }
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
     * v1 start. Routes through the daemon's v1-compat endpoint.
     */
    async handleStart(config: object, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.client!.startTunnelV1(config, noWait);
    }

    async handleUpdateConfig(config: object, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        this.assertClient();
        return this.client!.updateConfig(config, noWait);
    }

    async handleUpdateConfigV2(config: object, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse> {
        this.assertClient();
        return this.client!.updateConfigV2(config, noWait);
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

    async handleList(): Promise<TunnelResponse[] | ErrorResponse> {
        this.assertClient();
        return this.client!.listTunnelsV1();
    }

    async handleRemoveStoppedTunnelByTunnelId(tunnelId: string): Promise<boolean | ErrorResponse> {
        this.assertClient();
        const res = await this.client!.removeStoppedTunnel({ tunnelid: tunnelId });
        if (isErrorResponse(res)) return res;
        return true;
    }

    async handleRemoveStoppedTunnelByConfigId(configId: string): Promise<boolean | ErrorResponse> {
        this.assertClient();
        const res = await this.client!.removeStoppedTunnel({ configId });
        if (isErrorResponse(res)) return res;
        return true;
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

    async getLogLevel(): Promise<string> {
        this.assertClient();
        const res = await this.client!.getLogLevel();
        return (res as any).level;
    }

    async setLogLevel(level: "debug" | "info" | "error"): Promise<void> {
        this.assertClient();
        await this.client!.setLogLevel(level);
    }

    async getTunnelLogging(): Promise<boolean> {
        this.assertClient();
        const res = await this.client!.getTunnelLogging();
        return !!(res as any).enabled;
    }

    async setTunnelLogging(enabled: boolean): Promise<void> {
        this.assertClient();
        await this.client!.setTunnelLogging(enabled);
    }

    async getLogPaths(): Promise<{ daemon: string; tunnels: any[] }> {
        this.assertClient();
        return await this.client!.getLogPaths() as any;
    }

    async resolveLogPath(q: string): Promise<{ status: string; path?: string; tunnelId?: string; name?: string; running?: boolean }> {
        this.assertClient();
        return await this.client!.resolveLogPath(q) as any;
    }

    async restart(tunnelId: string): Promise<void> {
        this.assertClient();
        await this.client!.restartTunnel(tunnelId);
    }

    // Streaming (WebSocket)

    /**
     * Attach to a tunnel's event stream via WebSocket.
     * Opens WS connection if not already open, subscribes to tunnel events.
     */
    async attach(tunnelId: string, mode: "foreground" | "detached" = "foreground"): Promise<void> {
        if (this.daemonLost) return;
        await this.ensureWsConnection();
        await this.wsReady;

        if (this.subscribedTunnels.has(tunnelId)) {
            return; // Already subscribed
        }

        const msg: ClientMessage = { type: "subscribe", tunnelId, mode };
        this.ws!.send(JSON.stringify(msg));
        this.subscribedTunnels.set(tunnelId, { mode });
    }

    /**
     * Detach from a tunnel's event stream.
     * Does NOT close the WS connection (other tunnels may be subscribed).
     */
    detach(tunnelId: string): void {
        const wasSubscribed = this.subscribedTunnels.delete(tunnelId);
        if (!wasSubscribed) return;

        // Skip the unsubscribe message if the socket is gone — the daemon will
        // clean up server-side when our session closes.
        if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.daemonLost) {
            try {
                const msg: ClientMessage = { type: "unsubscribe", tunnelId };
                this.ws.send(JSON.stringify(msg));
            } catch { /* socket died between check and send */ }
        }

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

    // Daemon-loss events: fired when the WS to the daemon drops and we either
    // can't recover, or detect the daemon has been replaced/killed.
    onDaemonLost(cb: DaemonLostCallback): void {
        this.daemonLostCallbacks.push(cb);
    }

    onDaemonReconnecting(cb: DaemonReconnectingCallback): void {
        this.daemonReconnectingCallbacks.push(cb);
    }

    onDaemonReconnected(cb: DaemonReconnectedCallback): void {
        this.daemonReconnectedCallbacks.push(cb);
    }

    isDaemonLost(): boolean {
        return this.daemonLost;
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

    // Contract stub: TunnelHandler requires a sync return, but stats live in the daemon
    // and can't be fetched synchronously over HTTP. Real stats flow through onStats (WS push).
    handleGetTunnelStats(tunnelId: string): TunnelUsageType[] | ErrorResponse {
        return [{ numLiveConnections: 0, numTotalConnections: 0, numTotalReqBytes: 0, numTotalResBytes: 0, numTotalTxBytes: 0, elapsedTime: 0 }];
    }

    // Private

    private assertClient(): void {
        if (!this.client) {
            throw new Error("TunnelClient not initialized. Call ensureDaemon() first.");
        }
    }

    // Called when the WS closes. Code 1000 means we initiated the close (close());
    // anything else is a daemon-side close or a network drop and triggers the
    // reconnect loop. Skip if there's nothing to reconnect for.
    private handleWsClose(code: number): void {
        if (code === WS_NORMAL_CLOSE) return;
        if (this.daemonLost || this.reconnecting) return;
        if (this.subscribedTunnels.size === 0) return;

        this.reconnecting = true;
        this.attemptReconnect()
            .catch((err) => logger.debug("Reconnect loop threw", { error: err?.message }))
            .finally(() => { this.reconnecting = false; });
    }

    private async attemptReconnect(): Promise<void> {
        for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
            for (const cb of this.daemonReconnectingCallbacks) {
                try { cb(attempt, RECONNECT_ATTEMPTS); } catch { /* consumer errors must not break loop */ }
            }
            await sleep(RECONNECT_INTERVAL_MS);
            if (this.daemonLost) return;

            const info = getDaemonInfo();
            if (!info) {
                this.triggerDaemonLost("dead");
                return;
            }
            if (info.pid !== this.originalDaemonPid) {
                this.triggerDaemonLost("respawned", `was pid ${this.originalDaemonPid}, now pid ${info.pid}`);
                return;
            }
            try {
                await this.client!.ping(HEARTBEAT_TIMEOUT_MS);
                await this.reopenWsAndResubscribe();
                for (const cb of this.daemonReconnectedCallbacks) {
                    try { cb(); } catch { /* ignore */ }
                }
                return;
            } catch (err: any) {
                logger.debug("Reconnect attempt failed", { attempt, error: err?.message });
            }
        }
        this.triggerDaemonLost("hung");
    }

    private async reopenWsAndResubscribe(): Promise<void> {
        const snapshot = Array.from(this.subscribedTunnels.entries());
        this.subscribedTunnels.clear();
        this.ws = null;
        this.wsReady = null;
        this.wsResolve = null;

        await this.ensureWsConnection();
        await this.wsReady;

        for (const [tunnelId, info] of snapshot) {
            const msg: ClientMessage = { type: "subscribe", tunnelId, mode: info.mode };
            this.ws!.send(JSON.stringify(msg));
            this.subscribedTunnels.set(tunnelId, info);
        }
    }

    private triggerDaemonLost(reason: DaemonLostReason, detail?: string): void {
        if (this.daemonLost) return;
        this.daemonLost = true;
        this.stopHeartbeat();
        if (this.ws) {
            try { this.ws.terminate(); } catch { /* ignore */ }
            this.ws = null;
        }
        this.subscribedTunnels.clear();
        this.wsReady = null;
        this.wsResolve = null;
        for (const cb of this.daemonLostCallbacks) {
            try { cb(reason, detail); } catch (err: any) {
                logger.debug("daemon-lost callback threw", { error: err?.message });
            }
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        let consecutiveFailures = 0;
        this.heartbeatTimer = setInterval(async () => {
            if (this.daemonLost || this.reconnecting || !this.client) return;
            try {
                await this.client.ping(HEARTBEAT_TIMEOUT_MS);
                consecutiveFailures = 0;
            } catch (err: any) {
                consecutiveFailures += 1;
                if (consecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
                    this.triggerDaemonLost("heartbeat", err?.message);
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
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
            this.startHeartbeat();
        });

        this.ws.on("message", (data) => {
            this.handleWsMessage(data.toString());
        });

        this.ws.on("close", (code: number) => {
            this.stopHeartbeat();
            this.ws = null;
            this.wsReady = null;
            this.wsResolve = null;
            this.handleWsClose(code);
        });

        this.ws.on("error", (err) => {
            logger.debug("TunnelClient WS error", { error: err.message });
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

    // Contract stub: TunnelHandler requires a sync return, but stats live in the daemon
    // and can't be fetched synchronously over HTTP. Real stats flow through the WS stats event.
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
