/**
 * WsStream: owns the WebSocket connection to the daemon, tracks per-tunnel
 * subscriptions, and dispatches tunnel events to registered callbacks.
 *
 * Lifecycle decisions (reconnect, daemon-loss, heartbeat) live elsewhere.
 * This class only cares about "is the socket open and what should I do with
 * the bytes I receive". Consumers wire onOpen/onClose to drive policy.
 */
import { WebSocket } from "ws";
import { TunnelUsageType } from "@pinggy/pinggy";
import { logger } from "../../logger.js";
import {
    ClientMessage,
    TunnelEvent,
    TunnelEventPayloadMap,
} from "./wsProtocol.js";
import { errorMessage } from "../../utils/util.js";
import { SessionMode } from "../ipc/ipcRoutes.js";

// Public callback types — re-exported by tunnelClient.ts for external consumers.
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

export type SubscriptionMode = SessionMode;
export type SubscriptionInfo = { mode: SubscriptionMode };

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

export const WS_NORMAL_CLOSE = 1000;

export class WsStream {
    private ws: WebSocket | null = null;
    private wsReady: Promise<void> | null = null;
    private wsResolve: (() => void) | null = null;
    private subscribedTunnels: Map<string, SubscriptionInfo> = new Map();
    private callbacks: EventCallbacks = {
        stats: [], disconnect: [], reconnecting: [], reconnected: [],
        reconnection_failed: [], error: [], url_ready: [], worker_error: [],
        will_reconnect: [], stopped: [],
    };
    private openListeners: Array<() => void> = [];
    private closeListeners: Array<(code: number) => void> = [];

    constructor(private getWsUrl: () => string) {}

    // Lifecycle

    async ensureOpen(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        this.wsReady = new Promise<void>((resolve) => { this.wsResolve = resolve; });
        this.ws = new WebSocket(this.getWsUrl());

        this.ws.on("open", () => {
            if (this.wsResolve) { this.wsResolve(); this.wsResolve = null; }
            for (const cb of this.openListeners) {
                try { cb(); } catch (err) { logger.debug("WsStream open listener threw", { error: errorMessage(err) }); }
            }
        });

        this.ws.on("message", (data) => this.handleMessage(data.toString()));

        this.ws.on("close", (code: number) => {
            this.ws = null;
            this.wsReady = null;
            this.wsResolve = null;
            for (const cb of this.closeListeners) {
                try { cb(code); } catch (err) { logger.debug("WsStream close listener threw", { error: errorMessage(err) }); }
            }
        });

        this.ws.on("error", (err) => {
            logger.debug("WsStream WS error", { error: errorMessage(err) });
        });

        await this.wsReady;
    }

    /** Send a normal close (1000). Use for user-initiated shutdown. */
    closeNormally(): void {
        if (!this.ws) return;
        try { this.ws.close(WS_NORMAL_CLOSE, "Client closing"); } catch { /* socket may already be dead */ }
        this.ws = null;
        this.wsReady = null;
        this.wsResolve = null;
        this.subscribedTunnels.clear();
    }

    /** Hard kill the socket. Use when daemon is known dead. */
    terminate(): void {
        if (!this.ws) return;
        try { this.ws.terminate(); } catch { /* ignore */ }
        this.ws = null;
        this.wsReady = null;
        this.wsResolve = null;
        this.subscribedTunnels.clear();
    }

    isOpen(): boolean {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    // Subscriptions

    async subscribe(tunnelId: string, mode: SubscriptionMode = SessionMode.Foreground): Promise<void> {
        await this.ensureOpen();
        if (this.subscribedTunnels.has(tunnelId)) return;
        const msg: ClientMessage = { type: "subscribe", tunnelId, mode };
        this.ws!.send(JSON.stringify(msg));
        this.subscribedTunnels.set(tunnelId, { mode });
    }

    /**
     * Remove the local subscription. Sends an unsubscribe frame if the socket
     * is still open; if not, the daemon cleans up server-side when the session
     * closes. Returns true if the caller had this subscription.
     */
    unsubscribe(tunnelId: string): boolean {
        const wasSubscribed = this.subscribedTunnels.delete(tunnelId);
        if (!wasSubscribed) return false;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                const msg: ClientMessage = { type: "unsubscribe", tunnelId };
                this.ws.send(JSON.stringify(msg));
            } catch { /* socket died between check and send */ }
        }
        return true;
    }

    hasSubscriptions(): boolean { return this.subscribedTunnels.size > 0; }
    subscriptionCount(): number { return this.subscribedTunnels.size; }

    /** Snapshot of current subscriptions, for the reconnect path to replay. */
    snapshotSubscriptions(): Array<[string, SubscriptionInfo]> {
        return Array.from(this.subscribedTunnels.entries());
    }

    /**
     * Re-open the WS (fresh socket) and re-subscribe a previously captured set.
     * Clears existing state first so ensureOpen builds a new connection.
     */
    async restoreSubscriptions(snapshot: Array<[string, SubscriptionInfo]>): Promise<void> {
        this.subscribedTunnels.clear();
        this.ws = null;
        this.wsReady = null;
        this.wsResolve = null;

        await this.ensureOpen();

        for (const [tunnelId, info] of snapshot) {
            const msg: ClientMessage = { type: "subscribe", tunnelId, mode: info.mode };
            this.ws!.send(JSON.stringify(msg));
            this.subscribedTunnels.set(tunnelId, info);
        }
    }

    // Event registration

    onOpen(cb: () => void): void { this.openListeners.push(cb); }
    onClose(cb: (code: number) => void): void { this.closeListeners.push(cb); }

    onStats(cb: StatsCallback): void { this.callbacks.stats.push(cb); }
    onDisconnect(cb: DisconnectCallback): void { this.callbacks.disconnect.push(cb); }
    onReconnecting(cb: ReconnectingCallback): void { this.callbacks.reconnecting.push(cb); }
    onReconnected(cb: ReconnectedCallback): void { this.callbacks.reconnected.push(cb); }
    onReconnectionFailed(cb: ReconnectionFailedCallback): void { this.callbacks.reconnection_failed.push(cb); }
    onError(cb: ErrorCallback): void { this.callbacks.error.push(cb); }
    onUrlReady(cb: UrlReadyCallback): void { this.callbacks.url_ready.push(cb); }
    onWorkerError(cb: WorkerErrorCallback): void { this.callbacks.worker_error.push(cb); }
    onWillReconnect(cb: WillReconnectCallback): void { this.callbacks.will_reconnect.push(cb); }
    onStopped(cb: StoppedCallback): void { this.callbacks.stopped.push(cb); }

    // Private

    private handleMessage(raw: string): void {
        let msg: TunnelEvent;
        try { msg = JSON.parse(raw) as TunnelEvent; } catch { return; }
        if (msg.type !== "tunnel_event") return;

        const { tunnelId, event, payload } = msg;

        switch (event) {
            case "stats":
                for (const cb of this.callbacks.stats) cb(tunnelId, (payload as TunnelEventPayloadMap["stats"]).stats);
                break;
            case "disconnect": {
                const p = payload as TunnelEventPayloadMap["disconnect"];
                for (const cb of this.callbacks.disconnect) cb(tunnelId, p.error, p.messages);
                break;
            }
            case "reconnecting":
                for (const cb of this.callbacks.reconnecting) cb(tunnelId, (payload as TunnelEventPayloadMap["reconnecting"]).retryCnt);
                break;
            case "reconnected":
                for (const cb of this.callbacks.reconnected) cb(tunnelId, (payload as TunnelEventPayloadMap["reconnected"]).urls);
                break;
            case "reconnection_failed":
                for (const cb of this.callbacks.reconnection_failed) cb(tunnelId, (payload as TunnelEventPayloadMap["reconnection_failed"]).retryCnt);
                break;
            case "error": {
                const p = payload as TunnelEventPayloadMap["error"];
                for (const cb of this.callbacks.error) cb(tunnelId, p.message, p.isFatal);
                break;
            }
            case "url_ready":
                for (const cb of this.callbacks.url_ready) cb(tunnelId, (payload as TunnelEventPayloadMap["url_ready"]).urls);
                break;
            case "worker_error":
                for (const cb of this.callbacks.worker_error) cb(tunnelId, (payload as TunnelEventPayloadMap["worker_error"]).message);
                break;
            case "will_reconnect": {
                const p = payload as TunnelEventPayloadMap["will_reconnect"];
                for (const cb of this.callbacks.will_reconnect) cb(tunnelId, p.error, p.messages);
                break;
            }
            case "stopped":
                for (const cb of this.callbacks.stopped) cb(tunnelId);
                break;
        }
    }
}
