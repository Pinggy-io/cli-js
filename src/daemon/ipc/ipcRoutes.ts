/**
 * Typed IPC route contract shared by IPCClient (caller) and IPCServer (handler).
 * Each `Route` constant binds a `METHOD PATH` string used over the wire; the
 * `IPCRoutes` map binds that same key to its request and response shapes.
 *
 * Adding a route: add an entry to `Route`, then a matching key in `IPCRoutes`.
 * Both sides will fail to compile until the new handler is wired up.
 */
import { TunnelConfig, TunnelConfigV1 } from "../remote_management/remote_schema.js";
import { TunnelResponse, TunnelResponseV2 } from "../remote_management/handler.js";
import { ErrorResponse } from "../types.js";
import { TunnelOrigin } from "../tunnel_manager/TunnelManager.js";

export const Route = {
    Ping:               "GET /ping",
    ListTunnels:        "GET /tunnels",
    ListTunnelsV1:      "GET /tunnels-v1",
    StartTunnel:        "POST /tunnels/start",
    StartTunnelConfig:  "POST /tunnels/start-config",
    StartTunnelV1:      "POST /tunnels/start-v1",
    StopTunnel:         "POST /tunnels/stop",
    RestartTunnel:      "POST /tunnels/restart",
    UpdateConfig:       "POST /tunnels/update-config",
    UpdateConfigV2:     "POST /tunnels/update-config-v2",
    RemoveStopped:      "POST /tunnels/remove-stopped",
    Shutdown:           "POST /shutdown",
    GetLogLevel:        "GET /loglevel",
    SetLogLevel:        "POST /loglevel",
    GetTunnelLogging:   "GET /config/tunnel-logging",
    SetTunnelLogging:   "POST /config/tunnel-logging",
    GetLogPaths:        "GET /logs/paths",
} as const;

export const ParamRoute = {
    GetTunnel:       "GET /tunnels/:id",
    ResolveLogPath:  "GET /logs/resolve",
} as const;

export interface PingResponse {
    status: string;
    pid: number;
    uptime: number;
}

export type ListTunnelsResponse = (TunnelResponseV2 & { mode?: "foreground" | "detached" })[] | ErrorResponse;

export interface LogPathEntry {
    tunnelId: string;
    name?: string;
    origin: TunnelOrigin;
    path: string;
    mtime: number;
    running: boolean;
}

export interface LogPathsResponse {
    daemon: string;
    tunnels: LogPathEntry[];
}

export type ResolveLogPathResponse =
    | { status: "running" | "historical"; path: string; tunnelId: string; name?: string; origin: TunnelOrigin; running: boolean }
    | { status: "config-only"; name: string; configId: string }
    | { status: "not-found" };

export interface ShutdownResponse {
    status: string;
    errors: string[];
}

export type LogLevel = "debug" | "info" | "error";

export type IPCRoutes = {
    [Route.Ping]:              { req: void; res: PingResponse };

    [Route.ListTunnels]:       { req: void; res: ListTunnelsResponse };
    [Route.ListTunnelsV1]:     { req: void; res: TunnelResponse[] | ErrorResponse };

    [Route.StartTunnel]:       { req: { name: string };                                  res: TunnelResponseV2 | ErrorResponse };
    [Route.StartTunnelConfig]: { req: TunnelConfigV1;                                    res: TunnelResponseV2 | ErrorResponse };
    [Route.StartTunnelV1]:     { req: { config: TunnelConfig; noWait?: boolean };        res: TunnelResponse | ErrorResponse };
    [Route.StopTunnel]:        { req: { tunnelid: string };                              res: TunnelResponse | ErrorResponse };
    [Route.RestartTunnel]:     { req: { tunnelid: string };                              res: TunnelResponse | ErrorResponse };
    [Route.UpdateConfig]:      { req: { config: TunnelConfig; noWait?: boolean };        res: TunnelResponse | ErrorResponse };
    [Route.UpdateConfigV2]:    { req: { config: TunnelConfigV1; noWait?: boolean };      res: TunnelResponseV2 | ErrorResponse };
    [Route.RemoveStopped]:     { req: { tunnelid?: string; configId?: string };          res: { result: boolean | ErrorResponse } };

    [Route.Shutdown]:          { req: Record<string, never>; res: ShutdownResponse };

    [Route.GetLogLevel]:       { req: void; res: { level: LogLevel } };
    [Route.SetLogLevel]:       { req: { level: LogLevel }; res: { level: LogLevel; appliedTo: string } };

    [Route.GetTunnelLogging]:  { req: void; res: { enabled: boolean } };
    [Route.SetTunnelLogging]:  { req: { enabled: boolean }; res: { enabled: boolean } };

    [Route.GetLogPaths]:       { req: void; res: LogPathsResponse };
};

export type RouteKey = keyof IPCRoutes;
export type RouteReq<K extends RouteKey> = IPCRoutes[K]["req"];
export type RouteRes<K extends RouteKey> = IPCRoutes[K]["res"];

/**
 * Parameterized routes don't fit the static `METHOD PATH` key shape.
 * Kept as a small parallel registry.
 */
export type ParameterizedRoutes = {
    [ParamRoute.GetTunnel]:      { params: { tunnelId: string }; res: TunnelResponse | ErrorResponse };
    [ParamRoute.ResolveLogPath]: { params: { q: string };         res: ResolveLogPathResponse };
};
