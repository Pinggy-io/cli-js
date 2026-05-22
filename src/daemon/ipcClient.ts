/**
 * IPC HTTP client for communicating with the Pinggy daemon from the foreground CLI.
 * Simple, no external dependencies - uses Node's built-in http module.
 *
 * Route shapes live in ipcRoutes.ts; this file is just transport plus typed wrappers.
 */
import http from "node:http";
import {
    LogLevel,
    LogPathsResponse,
    ParameterizedRoutes,
    ParamRoute,
    PingResponse,
    ResolveLogPathResponse,
    Route,
    RouteKey,
    RouteReq,
    RouteRes,
    ShutdownResponse,
} from "./ipcRoutes.js";
import { TunnelConfig, TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { TunnelResponse, TunnelResponseV2 } from "../remote_management/handler.js";
import { ErrorResponse } from "../types.js";

const REQUEST_TIMEOUT_MS = 10000;

export type ClientOrigin = "app" | "cli" | "remote";

export class IPCClient {
    private port: number;
    private origin: ClientOrigin;

    constructor(port: number, origin: ClientOrigin = "cli") {
        this.port = port;
        this.origin = origin;
    }

    async ping(timeoutMs?: number): Promise<PingResponse> {
        return this.call(Route.Ping, undefined, timeoutMs);
    }

    async listTunnels(): Promise<RouteRes<typeof Route.ListTunnels>> {
        return this.call(Route.ListTunnels, undefined);
    }

    async getTunnel(tunnelId: string): Promise<ParameterizedRoutes[typeof ParamRoute.GetTunnel]["res"]> {
        return this.request<ParameterizedRoutes[typeof ParamRoute.GetTunnel]["res"]>("GET", `/tunnels/${tunnelId}`);
    }

    async startTunnel(name: string): Promise<TunnelResponseV2 | ErrorResponse> {
        return this.call(Route.StartTunnel, { name });
    }

    async startTunnelWithConfig(config: TunnelConfigV1): Promise<TunnelResponseV2 | ErrorResponse> {
        return this.call(Route.StartTunnelConfig, config);
    }

    async stopTunnel(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        return this.call(Route.StopTunnel, { tunnelid });
    }

    async restartTunnel(tunnelid: string): Promise<TunnelResponse | ErrorResponse> {
        return this.call(Route.RestartTunnel, { tunnelid });
    }

    // v1 operations (used by remote management via daemon)
    async startTunnelV1(config: TunnelConfig, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        return this.call(Route.StartTunnelV1, { config, noWait });
    }

    async listTunnelsV1(): Promise<TunnelResponse[] | ErrorResponse> {
        return this.call(Route.ListTunnelsV1, undefined);
    }

    async updateConfig(config: TunnelConfig, noWait?: boolean): Promise<TunnelResponse | ErrorResponse> {
        return this.call(Route.UpdateConfig, { config, noWait });
    }

    async updateConfigV2(config: TunnelConfigV1, noWait?: boolean): Promise<TunnelResponseV2 | ErrorResponse> {
        return this.call(Route.UpdateConfigV2, { config, noWait });
    }

    async removeStoppedTunnel(opts: { tunnelid?: string; configId?: string }): Promise<{ result: boolean | ErrorResponse }> {
        return this.call(Route.RemoveStopped, opts);
    }

    async shutdown(): Promise<ShutdownResponse> {
        return this.call(Route.Shutdown, {});
    }

    async getLogLevel(): Promise<{ level: LogLevel }> {
        return this.call(Route.GetLogLevel, undefined);
    }

    async setLogLevel(level: LogLevel): Promise<{ level: LogLevel; appliedTo: string }> {
        return this.call(Route.SetLogLevel, { level });
    }

    async getTunnelLogging(): Promise<{ enabled: boolean }> {
        return this.call(Route.GetTunnelLogging, undefined);
    }

    async setTunnelLogging(enabled: boolean): Promise<{ enabled: boolean }> {
        return this.call(Route.SetTunnelLogging, { enabled });
    }

    async getLogPaths(): Promise<LogPathsResponse> {
        return this.call(Route.GetLogPaths, undefined);
    }

    async resolveLogPath(q: string): Promise<ResolveLogPathResponse> {
        return this.request<ResolveLogPathResponse>("GET", `/logs/resolve?q=${encodeURIComponent(q)}`);
    }

    /**
     * Get the WebSocket URL for event streaming.
     */
    getWsUrl(): string {
        return `ws://127.0.0.1:${this.port}/ws`;
    }

    getPort(): number {
        return this.port;
    }

    private call<K extends RouteKey>(key: K, body: RouteReq<K>, timeoutMs?: number): Promise<RouteRes<K>> {
        const spaceIdx = key.indexOf(" ");
        const method = key.slice(0, spaceIdx);
        const path = key.slice(spaceIdx + 1);
        const payload = method === "GET" ? undefined : JSON.stringify(body ?? {});
        return this.request<RouteRes<K>>(method, path, payload, timeoutMs);
    }

    private request<T>(method: string, path: string, body?: string, timeoutMs?: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const headers: Record<string, string | number> = {
                "X-Pinggy-Origin": this.origin,
            };
            if (body) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = Buffer.byteLength(body);
            }
            const req = http.request(
                {
                    hostname: "127.0.0.1",
                    port: this.port,
                    path,
                    method,
                    headers,
                    timeout: timeoutMs ?? REQUEST_TIMEOUT_MS,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf-8");
                        const statusCode = res.statusCode ?? 0;
                        if (statusCode < 200 || statusCode >= 300) {
                            reject(new Error(`Daemon returned HTTP ${statusCode}: ${text.slice(0, 200)}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(text) as T);
                        } catch {
                            reject(new Error(`Invalid JSON from daemon: ${text.slice(0, 200)}`));
                        }
                    });
                }
            );

            req.on("error", (err) => reject(new Error(`Cannot connect to daemon: ${err.message}`)));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("Daemon request timed out"));
            });

            if (body) req.write(body);
            req.end();
        });
    }
}
