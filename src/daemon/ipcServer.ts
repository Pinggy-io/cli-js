/**
 * IPC HTTP + WebSocket Server for the Pinggy daemon.
 * Listens on 127.0.0.1 with an OS-assigned port.
 * HTTP routes delegate to TunnelOperations.
 * WebSocket provides real-time event streaming to CLI/App clients.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TunnelOperations } from "../remote_management/handler.js";
import { TunnelManager, TunnelOrigin } from "../tunnel_manager/TunnelManager.js";
import { TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { logger } from "../logger.js";
import { removeDaemonInfo, trackIPCTunnelStart, trackTunnelStop } from "./daemonChild.js";
import { clearDaemonState } from "./stateStore.js";
import { isErrorResponse } from "../types.js";
import { SessionTracker } from "./sessionTracker.js";
import {
    ClientMessage,
    createTunnelEvent,
    DaemonEventType,
    parseClientMessage,
    TunnelEventPayloadMap,
} from "./wsProtocol.js";

const VALID_ORIGINS: TunnelOrigin[] = ["app", "cli", "remote"];

function parseOrigin(req: http.IncomingMessage): TunnelOrigin {
    const raw = req.headers["x-pinggy-origin"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    return v && (VALID_ORIGINS as string[]).includes(v) ? (v as TunnelOrigin) : "cli";
}

/**
 * Parse a tunnel log filename. Expected formats:
 *   <origin>__<name>__<tunnelId>.log
 *   <origin>__<tunnelId>.log
 * Returns null if the filename does not start with a recognized origin.
 */
function parseTunnelLogFilename(filename: string): { origin: TunnelOrigin; name?: string; tunnelId: string } | null {
    const base = filename.replace(/\.log$/, "");
    const parts = base.split("__");
    if (parts.length < 2) return null;
    const origin = parts[0] as TunnelOrigin;
    if (!(VALID_ORIGINS as string[]).includes(origin)) return null;
    if (parts.length === 2) {
        return { origin, tunnelId: parts[1] };
    }
    const tunnelId = parts[parts.length - 1];
    const name = parts.slice(1, -1).join("__");
    return { origin, name, tunnelId };
}

interface RouteContext {
    origin: TunnelOrigin;
}

interface RouteHandler {
    (body: string, ctx: RouteContext): Promise<object>;
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

export type OnSessionDisconnect = (session: WsSession) => void;

export class IPCServer {
    private server: http.Server;
    private wss: WebSocketServer;
    private ops: TunnelOperations;
    private startedAt: number;
    private routes: Map<string, RouteHandler> = new Map();
    private sessions: Map<string, WsSession> = new Map();
    private sessionCounter = 0;
    private onSessionDisconnect: OnSessionDisconnect | null = null;
    private sessionTracker: SessionTracker | null = null;

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

    setSessionTracker(st: SessionTracker): void {
        this.sessionTracker = st;
    }

    /**
     * Get all active sessions (for SessionTracker inspection).
     */
    getSessions(): Map<string, WsSession> {
        return this.sessions;
    }

    private registerRoutes(): void {
        // GET routes
        this.routes.set("GET /ping", async () => ({
            status: "ok",
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        }));

        this.routes.set("GET /tunnels", async () => {
            const res = await this.ops.handleListV2();
            if (isErrorResponse(res)) return res;
            return res.map((t) => ({
                ...t,
                mode: this.sessionTracker?.getOwnership(t.tunnelid)?.mode,
            }));
        });

        // POST routes
        this.routes.set("POST /tunnels/start", async (body, ctx) => {
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
            const result = await this.ops.handleStartV2(config, false, ctx.origin);
            if (!isErrorResponse(result)) {
                trackIPCTunnelStart(result.tunnelid, ctx.origin);
            }
            return result;
        });

        this.routes.set("POST /tunnels/start-config", async (body, ctx) => {
            const config = JSON.parse(body) as TunnelConfigV1;
            if (!config) throw new Error("Missing tunnel config body");
            const result = await this.ops.handleStartV2(config, false, ctx.origin);
            if (!isErrorResponse(result)) {
                trackIPCTunnelStart(result.tunnelid, ctx.origin);
            }
            return result;
        });

        this.routes.set("POST /tunnels/stop", async (body) => {
            const { tunnelid } = JSON.parse(body);
            if (!tunnelid) throw new Error("Missing 'tunnelid' field");
            const result = await this.ops.handleStop(tunnelid);
            this.sessionTracker?.removeTunnel(tunnelid);
            if (!isErrorResponse(result)) {
                trackTunnelStop(tunnelid);
            }
            return result;
        });

        this.routes.set("POST /tunnels/restart", async (body) => {
            const { tunnelid } = JSON.parse(body);
            if (!tunnelid) throw new Error("Missing 'tunnelid' field");
            return await this.ops.handleRestart(tunnelid);
        });

        // v1 operations (used by remote management)
        this.routes.set("POST /tunnels/start-v1", async (body, ctx) => {
            const { config, noWait } = JSON.parse(body);
            if (!config) throw new Error("Missing 'config' field");
            const result = await this.ops.handleStart(config, noWait, ctx.origin);
            if (!isErrorResponse(result)) {
                trackIPCTunnelStart(result.tunnelid, ctx.origin);
            }
            return result;
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

        // Log level routes
        this.routes.set("GET /loglevel", async () => {
            const { getLogLevel } = await import("../logger.js");
            return { level: getLogLevel() };
        });

        this.routes.set("POST /loglevel", async (body) => {
            const { level } = JSON.parse(body);
            if (!["debug", "info", "error"].includes(level)) {
                throw new Error(`Invalid log level: ${level}. Must be debug, info, or error`);
            }
            const { setLogLevel } = await import("../logger.js");
            setLogLevel(level);
            return { level, appliedTo: "daemon-js+future-workers" };
        });

        this.routes.set("GET /config/tunnel-logging", async () => {
            const { isTunnelLoggingEnabled } = await import("../logger/tunnelLogger.js");
            return { enabled: isTunnelLoggingEnabled() };
        });

        this.routes.set("POST /config/tunnel-logging", async (body) => {
            const { enabled } = JSON.parse(body);
            if (typeof enabled !== "boolean") throw new Error("Missing 'enabled' boolean");
            const { setTunnelLoggingEnabled, isTunnelLoggingEnabled } = await import("../logger/tunnelLogger.js");
            setTunnelLoggingEnabled(enabled);
            return { enabled: isTunnelLoggingEnabled() };
        });

        // Log paths / resolve routes
        this.routes.set("GET /logs/paths", async () => {
            const { getTunnelLogDir, getDaemonLogPath } = await import("../utils/configDir.js");
            const fs = await import("node:fs");
            const path = await import("node:path");

            const logDir = getTunnelLogDir();
            const daemonPath = getDaemonLogPath();
            const tunnels: Array<{ tunnelId: string; name?: string; origin: TunnelOrigin; path: string; mtime: number; running: boolean }> = [];

            if (fs.existsSync(logDir)) {
                const files = fs.readdirSync(logDir).filter((f: string) => f.endsWith(".log") && !f.endsWith(".log.1") && !f.endsWith(".log.2") && !f.endsWith(".log.3"));
                const activeIds = TunnelManager.getInstance().getActiveTunnelIds();

                for (const file of files) {
                    const filePath = path.join(logDir, file);
                    const stat = fs.statSync(filePath);
                    const parsed = parseTunnelLogFilename(file);
                    if (!parsed) continue;

                    tunnels.push({
                        tunnelId: parsed.tunnelId,
                        name: parsed.name,
                        origin: parsed.origin,
                        path: filePath,
                        mtime: stat.mtimeMs,
                        running: activeIds.has(parsed.tunnelId),
                    });
                }
            }

            return { daemon: daemonPath, tunnels };
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

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        const url = req.url ?? "/";
        const routeKey = `${method} ${url}`;
        const ctx: RouteContext = { origin: parseOrigin(req) };

        const handler = this.routes.get(routeKey);
        if (!handler) {
            // Try pattern matching for parameterized routes
            const result = this.matchParameterizedRoute(method, url);
            if (result) {
                try {
                    const body = await this.readBody(req);
                    const response = await result.handler(body, ctx);
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
            const result = await handler(body, ctx);
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

        // GET /logs/resolve?q=<arg>
        if (method === "GET" && url.startsWith("/logs/resolve")) {
            const urlObj = new URL(url, "http://localhost");
            const q = urlObj.searchParams.get("q") || "";
            return {
                handler: async () => {
                    return await this.resolveLogPath(q);
                }
            };
        }

        return null;
    }

    private async resolveLogPath(q: string): Promise<object> {
        if (!q) return { status: "not-found" };

        const fs = await import("node:fs");
        const path = await import("node:path");
        const { getTunnelLogDir, getTunnelLogPath } = await import("../utils/configDir.js");
        const { listSavedConfigs } = await import("../cli/configStore.js");

        const logDir = getTunnelLogDir();

        // 1. Check in-memory running tunnels first
        const manager = TunnelManager.getInstance();
        const allTunnels = await manager.getAllTunnels();
        const activeIds = manager.getActiveTunnelIds();

        for (const t of allTunnels) {
            const name = t.tunnelName || (t.tunnelConfig as any)?.name;
            if (name === q || t.tunnelid === q || t.tunnelid.startsWith(q)) {
                const origin = (t as any).origin ?? "cli";
                const logPath = getTunnelLogPath(t.tunnelid, origin, name);
                const running = activeIds.has(t.tunnelid);
                return { status: running ? "running" : "historical", path: logPath, tunnelId: t.tunnelid, name, origin, running };
            }
        }

        // 2. Check filesystem for historical files
        if (fs.existsSync(logDir)) {
            const files = fs.readdirSync(logDir).filter((f: string) => f.endsWith(".log") && !f.includes(".log."));
            const matches: Array<{ path: string; mtime: number; tunnelId: string; name?: string; origin: TunnelOrigin }> = [];

            for (const file of files) {
                const parsed = parseTunnelLogFilename(file);
                if (!parsed) continue;

                const nameMatch = parsed.name === q;
                const idMatch = parsed.tunnelId === q || parsed.tunnelId.startsWith(q);

                if (nameMatch || idMatch) {
                    const filePath = path.join(logDir, file);
                    const stat = fs.statSync(filePath);
                    matches.push({ path: filePath, mtime: stat.mtimeMs, tunnelId: parsed.tunnelId, name: parsed.name, origin: parsed.origin });
                }
            }

            if (matches.length > 0) {
                matches.sort((a, b) => b.mtime - a.mtime);
                const best = matches[0];
                return { status: "historical", path: best.path, tunnelId: best.tunnelId, name: best.name, origin: best.origin, running: false };
            }
        }

        // 3. Check saved configs (config-only case)
        const saved = listSavedConfigs();
        const matchedConfig = saved.find(c => c.name === q || c.configId === q || c.configId.startsWith(q));
        if (matchedConfig) {
            return { status: "config-only", name: matchedConfig.name, configId: matchedConfig.configId };
        }

        return { status: "not-found" };
    }

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
                this.handleSubscribe(session, msg.tunnelId, msg.mode).catch((err) => {
                    logger.error("handleSubscribe failed", { sessionId: session.id, tunnelId: msg.tunnelId, error: err.message });
                });
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
            const workerErrorId = await manager.registerWorkerErrorListner(tunnelId, (_id, error) => {
                this.sendEvent(session, tunnelId, "worker_error", { message: error.message });
            });
            listenerIds.push(`worker_error:${workerErrorId}`);

            // Register start listener (for url_ready on reconnect)
            const startId = await manager.registerStartListener(tunnelId, (_id, urls) => {
                this.sendEvent(session, tunnelId, "url_ready", { urls });
            });
            listenerIds.push(`start:${startId}`);

            // All registrations succeeded. Commit subscription state atomically.
            session.subscriptions.set(tunnelId, { tunnelId, mode });
            this.sessionTracker?.attach(tunnelId, session.id, mode);
            session.listenerIds.set(tunnelId, listenerIds);

            this.sendEvent(session, tunnelId, "subscribed", { tunnelId });
        } catch (err: any) {
            // Clean up any listeners registered before the failure
            session.listenerIds.set(tunnelId, listenerIds);
            this.deregisterListeners(session, tunnelId);
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
                    case "worker_error":
                        manager.deregisterWorkerErrorListener(tunnelId, listenerId);
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
