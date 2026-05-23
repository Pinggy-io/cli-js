/**
 * WebSocket event protocol for daemon ↔ CLI/App communication.
 * Defines message types for bidirectional streaming over the IPC WebSocket.
 */
import { TunnelUsageType } from "@pinggy/pinggy";

// Client → Daemon Messages

export type ClientMessageType = "subscribe" | "unsubscribe";

export interface SubscribeMessage {
    type: "subscribe";
    tunnelId: string;
    mode: "foreground" | "detached";
}

export interface UnsubscribeMessage {
    type: "unsubscribe";
    tunnelId: string;
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage;

// Daemon → Client Messages

export type DaemonEventType =
    | "url_ready"
    | "stats"
    | "disconnect"
    | "reconnecting"
    | "reconnected"
    | "reconnection_failed"
    | "error"
    | "stopped"
    | "will_reconnect"
    | "worker_error"
    | "subscribed"
    | "error_response";

export interface TunnelEvent<T extends DaemonEventType = DaemonEventType> {
    type: "tunnel_event";
    tunnelId: string;
    event: T;
    payload: TunnelEventPayloadMap[T];
}

export interface TunnelEventPayloadMap {
    url_ready: { urls: string[] };
    stats: { stats: TunnelUsageType };
    disconnect: { error: string; messages: string[] };
    reconnecting: { retryCnt: number };
    reconnected: { urls: string[] };
    reconnection_failed: { retryCnt: number };
    error: { message: string; isFatal: boolean };
    stopped: {};
    will_reconnect: { error: string; messages: string[] };
    worker_error: { message: string };
    subscribed: { tunnelId: string };
    error_response: { message: string };
}

export type DaemonMessage = TunnelEvent;

// Helpers

export function createTunnelEvent<T extends DaemonEventType>(
    tunnelId: string,
    event: T,
    payload: TunnelEventPayloadMap[T]
): TunnelEvent<T> {
    return { type: "tunnel_event", tunnelId, event, payload };
}

export function parseClientMessage(raw: string): ClientMessage | null {
    try {
        const msg = JSON.parse(raw);
        if (msg.type === "subscribe" && msg.tunnelId) {
            return {
                type: "subscribe",
                tunnelId: msg.tunnelId,
                mode: msg.mode === "detached" ? "detached" : "foreground",
            };
        }
        if (msg.type === "unsubscribe" && msg.tunnelId) {
            return { type: "unsubscribe", tunnelId: msg.tunnelId };
        }
        return null;
    } catch {
        return null;
    }
}
