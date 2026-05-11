/**
 * IPC HTTP + WebSocket Server for the Pinggy daemon.
 * Listens on 127.0.0.1 with an OS-assigned port.
 * HTTP routes delegate to TunnelOperations.
 * WebSocket provides real-time event streaming to CLI/App clients.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TunnelOperations } from "../remote_management/handler.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { logger } from "../logger.js";
import { removeDaemonInfo } from "./daemonChild.js";
import { clearDaemonState } from "./stateStore.js";
import {
    ClientMessage,
    createTunnelEvent,
    DaemonEventType,
    parseClientMessage,
    TunnelEventPayloadMap,
} from "./wsProtocol.js";

// Types

interface RouteHandler {
    (body: string): Promise<object>;
}

export interface WsSubscription {
    tunnelId: string;
    mode: "foreground" | "detached";
}

export interface WsSession {
    id: string;
    ws: WebSocket;
    subscriptions: Map<string, WsSubscription>; // tunnelId → subscription
    listenerIds: Map<string, string[]>; // tunnelId → array of listener IDs to deregister
}

// Session Event Callbacks

export type OnSessionDisconnect = (session: WsSession) => void;

// IPC Server

export class IPCServer {
    private server: http.Server;
    private wss: WebSocketServer;
    private ops: TunnelOperations;
    private startedAt: number;
    private routes: Map<string, RouteHandler> = new Map();
    private sessions: Map<string, WsSession> = new Map();
    private sessionCounter = 0;
    private onSessionDisconnect: OnSessionDisconnect | null = null;

    constructor() {
        this.ops = new TunnelOperations();
        this.startedAt = Date.now();
        this.server = http.createServer(this.handleRequest.bind(this));
        this.wss = new WebSocketServer({ noServer: true });
        this.registerRoutes();
        this.setupWebSocket();
    }

    /**
     * Set callback for when a WS session disconnects.
     * Used by SessionTracker for orphan cleanup.
     */
    setOnSessionDisconnect(cb: OnSessionDisconnect): void {
        this.onSessionDisconnect = cb;
    }

    /**
     * Get all active sessions (for SessionTracker inspection).
     */
    getSessions(): Map<string, WsSession> {
        return this.sessions;
    }

    // HTTP Routes

    private registerRoutes(): void {
        // GET routes
        this.routes.set("GET /ping", async () => ({
            status: "ok",
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        }));

        this.routes.set("GET /tunnels", async () => {
            return await this.ops.handleListV2();
        });

        // POST routes
        this.routes.set("POST /tunnels/start", async (body) => {
            const { name } = JSON.parse(body);
            if (!name) throw new Error("Missing 'name' field");
            const { findConfig } = await import("../cli/configStore.js");
            const saved = findConfig(name);
            if (!saved) throw new Error(`No config found matching "${name}"`);

            const config = {
                ...saved.tunnelConfig,
                configId: saved.configId,
                name: saved.name,
            } as TunnelConfigV1;
            return await this.ops.handleStartV2(config);
        });

        this.routes.set("POST /tunnels/start-config", async (body) => {
            const config = JSON.parse(body) as TunnelConfigV1;
            if (!config) throw new Error("Missing tunnel config body");
            return await this.ops.handleStartV2(config);
        });

        this.routes.set("POST /tunnels/stop", async (body) => {
            const { tunnelid } = JSON.parse(body);
            if (!tunnelid) throw new Error("Missing 'tunnelid' field");
            return await this.ops.handleStop(tunnelid);
        });

        this.routes.set("POST /tunnels/restart", async (body) => {
            const { tunnelid } = JSON.parse(body);
            if (!tunnelid) throw new Error("Missing 'tunnelid' field");
            return await this.ops.handleRestart(tunnelid);
        });

        // v1 operations (used by remote management)
        this.routes.set("POST /tunnels/start-v1", async (body) => {
            const { config, noWait } = JSON.parse(body);
            if (!config) throw new Error("Missing 'config' field");
            return await this.ops.handleStart(config, noWait);
        });

        this.routes.set("GET /tunnels-v1", async () => {
            return await this.ops.handleList();
        });

        this.routes.set("POST /tunnels/update-config", async (body) => {
            const { config, noWait } = JSON.parse(body);
            if (!config) throw new Error("Missing 'config' field");
            return await this.ops.handleUpdateConfig(config, noWait);
        });

        this.routes.set("POST /tunnels/update-config-v2", async (body) => {
            const { config, noWait } = JSON.parse(body);
            if (!config) throw new Error("Missing 'config' field");
            return await this.ops.handleUpdateConfigV2(config, noWait);
        });

        this.routes.set("POST /tunnels/remove-stopped", async (body) => {
            const { tunnelid, configId } = JSON.parse(body);
            if (tunnelid) return { result: this.ops.handleRemoveStoppedTunnelByTunnelId(tunnelid) };
            if (configId) return { result: this.ops.handleRemoveStoppedTunnelByConfigId(configId) };
            throw new Error("Missing 'tunnelid' or 'configId' field");
        });

        this.routes.set("POST /shutdown", async () => {
            logger.info("Daemon shutdown requested via IPC");
            const errors: string[] = [];
            const step = (label: string, fn: () => void) => {
                try { fn(); } catch (e: any) {
                    errors.push(`${label}: ${e?.message ?? String(e)}`);
                    logger.error(`Shutdown step "${label}" failed`, { error: e?.message ?? e });
                }
            };

            // Remove pid/state files first so the next CLI run isn't blocked
            // even if a later step throws.
            step("removeDaemonInfo", removeDaemonInfo);
            step("clearDaemonState", clearDaemonState);
            step("stopAllTunnels", () => TunnelManager.getInstance().stopAllTunnels());

            setTimeout(() => process.exit(0), 200);
            return { status: "shutting_down", errors };
        });
    }

    // HTTP Request Handler

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        const url = req.url ?? "/";
        const routeKey = `${method} ${url}`;

        const handler = this.routes.get(routeKey);
        if (!handler) {
            // Try pattern matching for parameterized routes
            const result = this.matchParameterizedRoute(method, url);
            if (result) {
                try {
                    const body = await this.readBody(req);
                    const response = await result.handler(body);
                    this.sendJson(res, 200, response);
                } catch (err: any) {
                    logger.error("IPC handler error", { route: `${method} ${url}`, error: err.message });
                    this.sendJson(res, 500, { error: err.message });
                }
                return;
            }
            this.sendJson(res, 404, { error: "Not found", path: url });
            return;
        }

        try {
            const body = await this.readBody(req);
            const result = await handler(body);
            this.sendJson(res, 200, result);
        } catch (err: any) {
            logger.error("IPC handler error", { routeKey, error: err.message });
            this.sendJson(res, 500, { error: err.message });
        }
    }

    private matchParameterizedRoute(method: string, url: string): { handler: RouteHandler } | null {
        // GET /tunnels/:id
        if (method === "GET") {
            const match = url.match(/^\/tunnels\/([^/]+)$/);
            if (match) {
                const tunnelId = match[1];
                return {
                    handler: async () => {
                        return await this.ops.handleGet(tunnelId);
                    }
                };
            }
        }
        return null;
    }

    // WebSocket Setup

    private setupWebSocket(): void {
        this.server.on("upgrade", (req, socket, head) => {
            if (req.url === "/ws") {
                this.wss.handleUpgrade(req, socket, head, (ws) => {
                    this.wss.emit("connection", ws, req);
                });
            } else {
                socket.destroy();
            }
        });

        this.wss.on("connection", (ws) => {
            const session = this.createSession(ws);
            logger.info(`WS session connected: ${session.id}`);

            ws.on("message", (data) => {
                const raw = data.toString();
                const msg = parseClientMessage(raw);
                if (msg) {
                    this.handleClientMessage(session, msg);
                }
            });

            ws.on("close", () => {
                logger.info(`WS session disconnected: ${session.id}`);
                this.cleanupSession(session);
                if (this.onSessionDisconnect) {
                    this.onSessionDisconnect(session);
                }
            });

            ws.on("error", (err) => {
                logger.error(`WS session error: ${session.id}`, { error: err.message });
            });
        });
    }

    private createSession(ws: WebSocket): WsSession {
        const id = `ws_${++this.sessionCounter}_${Date.now()}`;
        const session: WsSession = {
            id,
            ws,
            subscriptions: new Map(),
            listenerIds: new Map(),
        };
        this.sessions.set(id, session);
        return session;
    }

    private handleClientMessage(session: WsSession, msg: ClientMessage): void {
        switch (msg.type) {
            case "subscribe":
                this.handleSubscribe(session, msg.tunnelId, msg.mode);
                break;
            case "unsubscribe":
                this.handleUnsubscribe(session, msg.tunnelId);
                break;
        }
    }

    private async handleSubscribe(session: WsSession, tunnelId: string, mode: "foreground" | "detached"): Promise<void> {
        // Avoid duplicate subscriptions
        if (session.subscriptions.has(tunnelId)) {
            return;
        }

        session.subscriptions.set(tunnelId, { tunnelId, mode });
        const listenerIds: string[] = [];
        const manager = TunnelManager.getInstance();

        try {
            // Register stats listener
            const [statsListenerId] = await manager.registerStatsListener(tunnelId, (_id, stats) => {
                this.sendEvent(session, tunnelId, "stats", { stats });
            });
            listenerIds.push(`stats:${statsListenerId}`);

            // Register disconnect listener
            const disconnectId = await manager.registerDisconnectListener(tunnelId, (_id, error, messages) => {
                this.sendEvent(session, tunnelId, "disconnect", { error, messages });
            });
            listenerIds.push(`disconnect:${disconnectId}`);

            // Register reconnecting listener
            const reconnectingId = await manager.registerReconnectingListener(tunnelId, (_id, retryCnt) => {
                this.sendEvent(session, tunnelId, "reconnecting", { retryCnt });
            });
            listenerIds.push(`reconnecting:${reconnectingId}`);

            // Register reconnection completed listener
            const reconnectedId = await manager.registerReconnectionCompletedListener(tunnelId, (_id, urls) => {
                this.sendEvent(session, tunnelId, "reconnected", { urls });
            });
            listenerIds.push(`reconnected:${reconnectedId}`);

            // Register reconnection failed listener
            const failedId = await manager.registerReconnectionFailedListener(tunnelId, (_id, retryCnt) => {
                this.sendEvent(session, tunnelId, "reconnection_failed", { retryCnt });
            });
            listenerIds.push(`failed:${failedId}`);

            // Register will-reconnect listener
            const willReconnectId = await manager.registerWillReconnectListener(tunnelId, (_id, error, messages) => {
                this.sendEvent(session, tunnelId, "will_reconnect", { error, messages });
            });
            listenerIds.push(`will_reconnect:${willReconnectId}`);

            // Register worker error listener
            manager.registerWorkerErrorListner(tunnelId, (_id, error) => {
                this.sendEvent(session, tunnelId, "worker_error", { message: error.message });
            });

            // Register start listener (for url_ready on reconnect)
            const startId = await manager.registerStartListener(tunnelId, (_id, urls) => {
                this.sendEvent(session, tunnelId, "url_ready", { urls });
            });
            listenerIds.push(`start:${startId}`);

            session.listenerIds.set(tunnelId, listenerIds);

            // Send confirmation
            this.sendEvent(session, tunnelId, "subscribed", { tunnelId });
        } catch (err: any) {
            this.sendEvent(session, tunnelId, "error_response", { message: err.message });
        }
    }

    private handleUnsubscribe(session: WsSession, tunnelId: string): void {
        this.deregisterListeners(session, tunnelId);
        session.subscriptions.delete(tunnelId);
    }

    private deregisterListeners(session: WsSession, tunnelId: string): void {
        const ids = session.listenerIds.get(tunnelId);
        if (!ids) return;

        const manager = TunnelManager.getInstance();
        for (const entry of ids) {
            const [type, listenerId] = entry.split(":");
            try {
                switch (type) {
                    case "stats":
                        manager.deregisterStatsListener(tunnelId, listenerId);
                        break;
                    case "disconnect":
                        manager.deregisterDisconnectListener(tunnelId, listenerId);
                        break;
                    case "reconnecting":
                        manager.deregisterReconnectingListener(tunnelId, listenerId);
                        break;
                    case "reconnected":
                        manager.deregisterReconnectionCompletedListener(tunnelId, listenerId);
                        break;
                    case "failed":
                        manager.deregisterReconnectionFailedListener(tunnelId, listenerId);
                        break;
                    case "will_reconnect":
                        manager.deregisterWillReconnectListener(tunnelId, listenerId);
                        break;
                    case "start":
                        // Start listener doesn't have a deregister (fire-once pattern)
                        break;
                }
            } catch {
                // Tunnel may already be stopped
            }
        }
        session.listenerIds.delete(tunnelId);
    }

    private cleanupSession(session: WsSession): void {
        // Deregister all listeners for this session
        for (const tunnelId of session.subscriptions.keys()) {
            this.deregisterListeners(session, tunnelId);
        }
        session.subscriptions.clear();
        this.sessions.delete(session.id);
    }

    private sendEvent<T extends DaemonEventType>(
        session: WsSession,
        tunnelId: string,
        event: T,
        payload: TunnelEventPayloadMap[T]
    ): void {
        if (session.ws.readyState === WebSocket.OPEN) {
            const msg = createTunnelEvent(tunnelId, event, payload);
            session.ws.send(JSON.stringify(msg));
        }
    }

    // HTTP Utilities

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const MAX_BODY = 1024 * 64; // 64KB limit

            req.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY) {
                    req.destroy();
                    reject(new Error("Request body too large"));
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            req.on("error", reject);
        });
    }

    private sendJson(res: http.ServerResponse, statusCode: number, data: object): void {
        const body = JSON.stringify(data);
        res.writeHead(statusCode, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
    }

    /**
     * Start listening on 127.0.0.1 with OS-assigned port.
     * Returns the assigned port.
     */
    listen(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server.on("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                const addr = this.server.address() as { port: number };
                logger.info(`IPC server listening on 127.0.0.1:${addr.port}`);
                resolve(addr.port);
            });
        });
    }

    close(): Promise<void> {
        return new Promise((resolve) => {
            // Close all WS connections
            for (const session of this.sessions.values()) {
                session.ws.close(1001, "Daemon shutting down");
            }
            this.wss.close();
            this.server.close(() => resolve());
        });
    }
}
