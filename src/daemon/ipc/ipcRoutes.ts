/**
 * Typed IPC route contract shared by IPCClient (caller) and IPCServer (handler).
 * Each `Route` constant binds a `METHOD PATH` string used over the wire; the
 * `IPCRoutes` map binds that same key to its request and response shapes.
 *
 * Adding a route: add an entry to `Route`, then a matching key in `IPCRoutes`.
 * Both sides will fail to compile until the new handler is wired up.
 */
import { TunnelConfig, TunnelConfigV1 } from "../../remote_management/remote_schema.js";
import { TunnelResponse, TunnelResponseV2 } from "../../remote_management/handler.js";
import { ErrorResponse } from "../../types.js";
import { TunnelOrigin } from "../../tunnel_manager/TunnelManager.js";
import type { TunnelUsageType } from "@pinggy/pinggy";

/**
 * IPC protocol version shared by the CLI and the daemon.
 * The daemon stamps it into daemon.json and returns it from GET /ping.
 * The CLI refuses to talk to a daemon whose version differs.
 *
 * Bump this whenever a route's request or response shape, or the WebSocket
 * protocol, changes in a way an older peer cannot handle.
 */
export const IPC_VERSION = 1;

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
    GetDeviceAgent:     "GET /device",
    StartDeviceAgent:   "POST /device/start",
    StopDeviceAgent:    "POST /device/stop",
} as const;

export const ParamRoute = {
    GetTunnel:       "GET /tunnels/:id",
    GetTunnelStats:  "GET /tunnels/:id/stats",
    ResolveLogPath:  "GET /logs/resolve",
} as const;

export interface PingResponse {
    status: string;
    pid: number;
    uptime: number;
    ipcVersion: number;
}

export type ListTunnelsResponse = (TunnelResponseV2 & { mode?: SessionMode })[] | ErrorResponse;

export interface LogPathEntry {
    tunnelId?: string;
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
    | { status: "running" | "historical"; path: string; tunnelId?: string; name?: string; origin: TunnelOrigin; running: boolean }
    | { status: "config-only"; name: string; configId: string }
    | { status: "not-found" };

// Who hosts the daemon process: a standalone CLI child, or in-process inside
// the Pinggy desktop app. 
export const DaemonHost = {
    CLI: "cli",
    APP: "app",
} as const;
export type DaemonHost = typeof DaemonHost[keyof typeof DaemonHost];

export const ShutdownStatus = {
    ShuttingDown: "shutting_down",
    RefusedInApp: "refused_in_app",
} as const;
export type ShutdownStatus = typeof ShutdownStatus[keyof typeof ShutdownStatus];

export interface ShutdownResponse {
    status: ShutdownStatus;
    errors: string[];
}

export type LogLevel = "debug" | "info" | "error";

export const DeviceAgentState = {
    Stopped: "stopped",
    Connecting: "connecting",
    Connected: "connected",
    Reconnecting: "reconnecting",
} as const;
export type DeviceAgentState = typeof DeviceAgentState[keyof typeof DeviceAgentState];

/** Why a device agent run ended for good. `code` names 1 of the agent's terminal outcomes. */
export interface DeviceAgentError {
    code: string;
    message: string;
}

/**
 * The device agent the daemon runs for `pinggy devices connect -b`. It never carries the token: any
 * local user can reach the IPC port.
 */
export interface DeviceAgentStatus {
    state: DeviceAgentState;
    deviceAgentId: string | null;
    server: string | null;
    /** The owner's email, from `welcome`. */
    email: string | null;
    /** The device's page in the dashboard, from `welcome`. */
    deviceUrl: string | null;
    startedAt: string | null;
    connectedAt: string | null;
    startedBy: TunnelOrigin | null;
    lastError: DeviceAgentError | null;
}

export const SessionMode = {
    Foreground: "foreground",
    Detached: "detached",
} as const;
export type SessionMode = typeof SessionMode[keyof typeof SessionMode];

export type IPCRoutes = {
    [Route.Ping]:              { req: void; res: PingResponse };

    [Route.ListTunnels]:       { req: void; res: ListTunnelsResponse };
    [Route.ListTunnelsV1]:     { req: void; res: TunnelResponse[] | ErrorResponse };

    [Route.StartTunnel]:       { req: { name: string; mode: SessionMode };              res: TunnelResponseV2 | ErrorResponse };
    [Route.StartTunnelConfig]: { req: { config: TunnelConfigV1; mode: SessionMode; noWait?: boolean }; res: TunnelResponseV2 | ErrorResponse };
    [Route.StartTunnelV1]:     { req: { config: TunnelConfig; mode: SessionMode; noWait?: boolean };   res: TunnelResponse | ErrorResponse };
    [Route.StopTunnel]:        { req: { tunnelid: string };                              res: TunnelResponse | ErrorResponse };
    [Route.RestartTunnel]:     { req: { tunnelid: string; noWait?: boolean };            res: TunnelResponse | ErrorResponse };
    [Route.UpdateConfig]:      { req: { config: TunnelConfig; noWait?: boolean };        res: TunnelResponse | ErrorResponse };
    [Route.UpdateConfigV2]:    { req: { config: TunnelConfigV1; noWait?: boolean };      res: TunnelResponseV2 | ErrorResponse };
    [Route.RemoveStopped]:     { req: { tunnelid?: string; configId?: string };          res: { result: boolean | ErrorResponse } };

    [Route.Shutdown]:          { req: Record<string, never>; res: ShutdownResponse };

    [Route.GetLogLevel]:       { req: void; res: { level: LogLevel } };
    [Route.SetLogLevel]:       { req: { level: LogLevel }; res: { level: LogLevel; appliedTo: string } };

    [Route.GetTunnelLogging]:  { req: void; res: { enabled: boolean } };
    [Route.SetTunnelLogging]:  { req: { enabled: boolean }; res: { enabled: boolean } };

    [Route.GetLogPaths]:       { req: void; res: LogPathsResponse };

    // No request field: the daemon reads the token and the server from device.json.
    [Route.GetDeviceAgent]:    { req: void; res: DeviceAgentStatus };
    [Route.StartDeviceAgent]:  { req: Record<string, never>; res: DeviceAgentStatus | ErrorResponse };
    [Route.StopDeviceAgent]:   { req: Record<string, never>; res: DeviceAgentStatus };
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
    [ParamRoute.GetTunnelStats]: { params: { tunnelId: string }; res: TunnelUsageType[] | ErrorResponse };
    [ParamRoute.ResolveLogPath]: { params: { q: string };         res: ResolveLogPathResponse };
};
