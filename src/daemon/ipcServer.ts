/**
 * IPC HTTP Server for the Pinggy daemon.
 * Listens on 127.0.0.1 with an OS-assigned port.
 * Routes delegate to TunnelOperations — same logic the WebSocket remote management uses.
 */
import http from "node:http";
import { TunnelOperations } from "../remote_management/handler.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { logger } from "../logger.js";

interface RouteHandler {
    (body: string): Promise<object>;
}

export class IPCServer {
    private server: http.Server;
    private ops: TunnelOperations;
    private startedAt: number;
    private routes: Map<string, RouteHandler> = new Map();

    constructor() {
        this.ops = new TunnelOperations();
        this.startedAt = Date.now();
        this.server = http.createServer(this.handleRequest.bind(this));
        this.registerRoutes();
    }

    private registerRoutes(): void {
        // GET routes (body is ignored)
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
            if (!name) return { error: "Missing 'name' field" };
            // Import at call time to avoid circular deps
            const { findConfig } = await import("../cli/configStore.js");
            const saved = findConfig(name);
            if (!saved) return { error: `No config found matching "${name}"` };

            const config = {
                ...saved.tunnelConfig,
                configId: saved.configId,
                name: saved.name,
            } as TunnelConfigV1;
            return await this.ops.handleStartV2(config);
        });

        this.routes.set("POST /tunnels/stop", async (body) => {
            const { tunnelid } = JSON.parse(body);
            if (!tunnelid) return { error: "Missing 'tunnelid' field" };
            return await this.ops.handleStop(tunnelid);
        });

        this.routes.set("POST /shutdown", async () => {
            // Graceful shutdown: stop tunnels, close server, exit
            logger.info("Daemon shutdown requested via IPC");
            const manager = TunnelManager.getInstance();
            manager.stopAllTunnels();
            // Defer exit so the response can be sent
            setTimeout(() => process.exit(0), 200);
            return { status: "shutting_down" };
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        const url = req.url ?? "/";
        const routeKey = `${method} ${url}`;

        const handler = this.routes.get(routeKey);
        if (!handler) {
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
            this.server.close(() => resolve());
        });
    }
}
