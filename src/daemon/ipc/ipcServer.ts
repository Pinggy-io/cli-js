/**
 * IPC HTTP + WebSocket Server for the Pinggy daemon.
 * Listens on 127.0.0.1 with an OS-assigned port.
 * HTTP routes delegate to TunnelOperations.
 * WebSocket provides real-time event streaming to CLI/App clients.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TunnelOperations } from "../../main.js";
import { TunnelManager } from "../../main.js";
import { TunnelConfigV1 } from "../../remote_management/remote_schema.js";
import { logger } from "../../logger.js";
import {
    IPCRoutes,
    ParameterizedRoutes,
    ParamRoute,
    ResolveLogPathResponse,
    Route,
    RouteKey,
    RouteReq,
    RouteRes,
} from "./ipcRoutes.js";
import {
    ClientMessage,
    createTunnelEvent,
    DaemonEventType,
    parseClientMessage,
    TunnelEventPayloadMap,
} from "../ws/wsProtocol.js";
import { TunnelOrigin } from "../../tunnel_manager/TunnelManager.js";
import { SessionTracker } from "../lifecycle/sessionTracker.js";
import { isErrorResponse } from "../../types.js";
import { removeDaemonInfo, trackIPCTunnelStart, trackTunnelStop } from "../lifecycle/daemonChild.js";
import { clearDaemonState } from "../lifecycle/stateStore.js";

const VALID_ORIGINS: TunnelOrigin[] = ["app", "cli", "remote"];

function parseOrigin(req: http.IncomingMessage): TunnelOrigin {
    const raw = req.headers["x-pinggy-origin"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    return v && (VALID_ORIGINS as string[]).includes(v) ? (v as TunnelOrigin) : "cli";
}

function parseBody(method: string, body: string): unknown {
    if (method === "GET") return undefined;
    if (!body) return {};
    return JSON.parse(body);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a tunnel log filename. Expected formats:
 *   <origin>__<name>.log              (saved/named tunnel)
 *   <origin>__<tunnelId>.log          (ad-hoc tunnel)
 *   <origin>__<name>__<tunnelId>.log  (legacy; pre single-file-per-name change)
 * Returns null if the filename does not start with a recognized origin.
 */
function parseTunnelLogFilename(filename: string): { origin: TunnelOrigin; name?: string; tunnelId?: string } | null {
    const base = filename.replace(/\.log$/, "");
    const parts = base.split("__");
    if (parts.length < 2) return null;
    const origin = parts[0] as TunnelOrigin;
    if (!(VALID_ORIGINS as string[]).includes(origin)) return null;
    if (parts.length === 2) {
        const second = parts[1];
        if (UUID_RE.test(second)) return { origin, tunnelId: second };
        return { origin, name: second };
    }
    // 3+ parts: legacy <origin>__<name>__<tunnelId>.log
    const tunnelId = parts[parts.length - 1];
    const name = parts.slice(1, -1).join("__");
    return { origin, name, tunnelId };
}

interface RouteContext {
    origin: TunnelOrigin;
}

type RouteHandler<K extends RouteKey> = (req: RouteReq<K>, ctx: RouteContext) => Promise<RouteRes<K>>;

type RouteHandlers = { [K in RouteKey]: RouteHandler<K> };

type ParamHandler<K extends keyof ParameterizedRoutes> = (params: ParameterizedRoutes[K]["params"]) => Promise<ParameterizedRoutes[K]["res"]>;

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
    private routes: RouteHandlers;
    private sessions: Map<string, WsSession> = new Map();
    private sessionCounter = 0;
    private onSessionDisconnect: OnSessionDisconnect | null = null;
    private sessionTracker: SessionTracker | null = null;

    constructor() {
        this.ops = new TunnelOperations();
        this.startedAt = Date.now();
        this.server = http.createServer(this.handleRequest.bind(this));
        this.wss = new WebSocketServer({ noServer: true });
        this.routes = this.buildRoutes();
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

    private buildRoutes(): RouteHandlers {
        return {
            [Route.Ping]: async () => ({
                status: "ok",
                pid: process.pid,
                uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            }),

            [Route.ListTunnels]: async () => {
                const res = await this.ops.handleListV2();
                if (isErrorResponse(res)) return res;
                return res.map((t) => ({
                    ...t,
                    mode: this.sessionTracker?.getOwnership(t.tunnelid)?.mode,
                }));
            },

            [Route.ListTunnelsV1]: async () => {
                return await this.ops.handleList();
            },

            [Route.StartTunnel]: async (req, ctx) => {
                if (!req.name) throw new Error("Missing 'name' field");
                const { findConfig } = await import("../../cli/configStore.js");
                const saved = findConfig(req.name);
                if (!saved) throw new Error(`No config found matching "${req.name}"`);

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
            },

            [Route.StartTunnelConfig]: async (req, ctx) => {
                if (!req) throw new Error("Missing tunnel config body");
                const result = await this.ops.handleStartV2(req, false, ctx.origin);
                if (!isErrorResponse(result)) {
                    trackIPCTunnelStart(result.tunnelid, ctx.origin);
                }
                return result;
            },

            [Route.StartTunnelV1]: async (req, ctx) => {
                if (!req.config) throw new Error("Missing 'config' field");
                const result = await this.ops.handleStart(req.config, req.noWait, ctx.origin);
                if (!isErrorResponse(result)) {
                    trackIPCTunnelStart(result.tunnelid, ctx.origin);
                }
                return result;
            },

            [Route.StopTunnel]: async (req) => {
                if (!req.tunnelid) throw new Error("Missing 'tunnelid' field");
                const result = await this.ops.handleStop(req.tunnelid);
                this.sessionTracker?.removeTunnel(req.tunnelid);
                if (!isErrorResponse(result)) {
                    trackTunnelStop(req.tunnelid);
                }
                return result;
            },

            [Route.RestartTunnel]: async (req) => {
                if (!req.tunnelid) throw new Error("Missing 'tunnelid' field");
                return await this.ops.handleRestart(req.tunnelid);
            },

            [Route.UpdateConfig]: async (req) => {
                if (!req.config) throw new Error("Missing 'config' field");
                return await this.ops.handleUpdateConfig(req.config, req.noWait);
            },

            [Route.UpdateConfigV2]: async (req) => {
                if (!req.config) throw new Error("Missing 'config' field");
                return await this.ops.handleUpdateConfigV2(req.config, req.noWait);
            },

            [Route.RemoveStopped]: async (req) => {
                if (req.tunnelid) return { result: this.ops.handleRemoveStoppedTunnelByTunnelId(req.tunnelid) };
                if (req.configId) return { result: this.ops.handleRemoveStoppedTunnelByConfigId(req.configId) };
                throw new Error("Missing 'tunnelid' or 'configId' field");
            },

            [Route.GetLogLevel]: async () => {
                const { getLogLevel } = await import("../../logger.js");
                return { level: getLogLevel() as "debug" | "info" | "error" };
            },

            [Route.SetLogLevel]: async (req) => {
                if (!["debug", "info", "error"].includes(req.level)) {
                    throw new Error(`Invalid log level: ${req.level}. Must be debug, info, or error`);
                }
                const { setLogLevel } = await import("../../logger.js");
                setLogLevel(req.level);
                return { level: req.level, appliedTo: "daemon-js+active-workers-js+future-workers" };
            },

            [Route.GetTunnelLogging]: async () => {
                const { isTunnelLoggingEnabled } = await import("../../logger/tunnelLogger.js");
                return { enabled: isTunnelLoggingEnabled() };
            },

            [Route.SetTunnelLogging]: async (req) => {
                if (typeof req.enabled !== "boolean") throw new Error("Missing 'enabled' boolean");
                const { setTunnelLoggingEnabled, isTunnelLoggingEnabled } = await import("../../logger/tunnelLogger.js");
                setTunnelLoggingEnabled(req.enabled);
                return { enabled: isTunnelLoggingEnabled() };
            },

            [Route.GetLogPaths]: async () => {
                const { getTunnelLogDir, getDaemonLogPath } = await import("../../utils/configDir.js");
                const fs = await import("node:fs");
                const path = await import("node:path");

                const logDir = getTunnelLogDir();
                const daemonPath = getDaemonLogPath();
                const tunnels: IPCRoutes[typeof Route.GetLogPaths]["res"]["tunnels"] = [];

                if (fs.existsSync(logDir)) {
                    const files = fs.readdirSync(logDir).filter((f: string) => f.endsWith(".log") && !/\.log\.\d+$/.test(f));
                    const manager = TunnelManager.getInstance();
                    const activeIds = manager.getActiveTunnelIds();
                    const activeNames = new Set<string>();
                    for (const t of await manager.getAllTunnels()) {
                        if (!activeIds.has(t.tunnelid)) continue;
                        const n = (t as any).tunnelName ?? (t as any).tunnelConfig?.name;
                        if (n) activeNames.add(n);
                    }

                    for (const file of files) {
                        const filePath = path.join(logDir, file);
                        const stat = fs.statSync(filePath);
                        const parsed = parseTunnelLogFilename(file);
                        if (!parsed) continue;

                        const running = parsed.tunnelId
                            ? activeIds.has(parsed.tunnelId)
                            : parsed.name ? activeNames.has(parsed.name) : false;

                        tunnels.push({
                            tunnelId: parsed.tunnelId,
                            name: parsed.name,
                            origin: parsed.origin,
                            path: filePath,
                            mtime: stat.mtimeMs,
                            running,
                        });
                    }
                }

                return { daemon: daemonPath, tunnels };
            },

            [Route.Shutdown]: async () => {
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
            },
        };
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        const url = req.url ?? "/";
        const ctx: RouteContext = { origin: parseOrigin(req) };

        // Strip query string for static lookup; parameterized routes parse the URL themselves.
        const pathOnly = url.split("?")[0];
        const routeKey = `${method} ${pathOnly}` as RouteKey;
        // The handler lookup loses the per-key correlation; cast to a generic
        // shape on dispatch. Per-handler bodies remain strongly typed at definition.
        type AnyHandler = (req: unknown, ctx: RouteContext) => Promise<unknown>;
        const handler = (this.routes as Record<string, AnyHandler | undefined>)[routeKey];

        if (handler) {
            try {
                const body = await this.readBody(req);
                const parsed = parseBody(method, body);
                const result = await handler(parsed, ctx);
                this.sendJson(res, 200, result as object);
            } catch (err: any) {
                logger.error("IPC handler error", { routeKey, error: err.message });
                this.sendJson(res, 500, { error: err.message });
            }
            return;
        }

        const paramMatch = this.matchParameterizedRoute(method, url);
        if (paramMatch) {
            try {
                await this.readBody(req);
                const response = await paramMatch.invoke();
                this.sendJson(res, 200, response as object);
            } catch (err: any) {
                logger.error("IPC handler error", { route: `${method} ${url}`, error: err.message });
                this.sendJson(res, 500, { error: err.message });
            }
            return;
        }

        this.sendJson(res, 404, { error: "Not found", path: url });
    }

    private matchParameterizedRoute(method: string, url: string): { invoke: () => Promise<unknown> } | null {
        if (method === "GET") {
            const match = url.match(/^\/tunnels\/([^/?]+)(?:\?.*)?$/);
            if (match) {
                const tunnelId = match[1];
                const handler: ParamHandler<typeof ParamRoute.GetTunnel> = async ({ tunnelId: id }) => this.ops.handleGet(id);
                return { invoke: () => handler({ tunnelId }) };
            }
        }

        if (method === "GET" && url.startsWith("/logs/resolve")) {
            const urlObj = new URL(url, "http://localhost");
            const q = urlObj.searchParams.get("q") || "";
            const handler: ParamHandler<typeof ParamRoute.ResolveLogPath> = async ({ q: query }) => this.resolveLogPath(query);
            return { invoke: () => handler({ q }) };
        }

        return null;
    }

    private async resolveLogPath(q: string): Promise<ResolveLogPathResponse> {
        if (!q) return { status: "not-found" };

        const fs = await import("node:fs");
        const path = await import("node:path");
        const { getTunnelLogDir, getTunnelLogPath } = await import("../../utils/configDir.js");
        const { listSavedConfigs } = await import("../../cli/configStore.js");

        const logDir = getTunnelLogDir();

        // 1. Active tunnel match. Stopped records fall through to the
        //    filesystem scan so the newest file by mtime wins.
        const manager = TunnelManager.getInstance();
        const activeIds = manager.getActiveTunnelIds();

        for (const t of await manager.getAllTunnels()) {
            if (!activeIds.has(t.tunnelid)) continue;
            const name = (t as any).tunnelName ?? (t as any).tunnelConfig?.name;
            if (name === q || t.tunnelid === q || t.tunnelid.startsWith(q)) {
                const origin = (t as any).origin ?? "cli";
                const logPath = getTunnelLogPath(t.tunnelid, origin, name);
                return { status: "running", path: logPath, tunnelId: t.tunnelid, name, origin, running: true };
            }
        }

        // 2. Filesystem scan for historical files. Returns the newest match by mtime.
        if (fs.existsSync(logDir)) {
            const files = fs.readdirSync(logDir).filter((f: string) => f.endsWith(".log") && !/\.log\.\d+$/.test(f));
            const matches: Array<{ path: string; mtime: number; tunnelId?: string; name?: string; origin: TunnelOrigin }> = [];

            for (const file of files) {
                const parsed = parseTunnelLogFilename(file);
                if (!parsed) continue;

                const nameMatch = parsed.name !== undefined && parsed.name === q;
                const idMatch = parsed.tunnelId !== undefined && (parsed.tunnelId === q || parsed.tunnelId.startsWith(q));

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

            // Register stopped listener (fires on intentional stopTunnel(), not on network drops)
            const stoppedId = await manager.registerStoppedListener(tunnelId, () => {
                this.sendEvent(session, tunnelId, "stopped", {});
            });
            listenerIds.push(`stopped:${stoppedId}`);

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
                    case "stopped":
                        manager.deregisterStoppedListener(tunnelId, listenerId);
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
