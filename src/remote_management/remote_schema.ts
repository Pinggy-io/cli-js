import { PinggyOptions } from "@pinggy/pinggy";
import { z } from "zod";


export const HeaderModificationSchema = z.object({
  key: z.string(),
  value: z.string().optional(),
  action: z.enum(["add", "remove", "update"]),
});

// TunnelConfig schema
export const TunnelConfigSchema = z.object({
  allowpreflight: z.boolean(),
  autoreconnect: z.boolean(),
  basicauth: z.string().nullable(),
  bearerauth: z.string().nullable(),
  configid: z.string().uuid(),
  configname: z.string(),
  force: z.boolean(),
  forwardedhost: z.string(),
  fullRequestUrl: z.boolean(),
  headermodification: z.array(HeaderModificationSchema),
  httpsOnly: z.boolean(),
  internalwebdebuggerport: z.number(),
  ipwhitelist: z.array(z.string()).nullable(),
  localport: z.number(),
  localsservertls: z.boolean(),
  localservertlssni: z.string().nullable(),
  regioncode: z.string(),
  noReverseProxy: z.boolean(),
  serveraddress: z.string(),
  serverport: z.number(),
  statusCheckInterval: z.number(),
  token: z.string(),
  tunnelTimeout: z.number(),
  type: z.enum(["http", "tcp", "tls", "udp"]),
  webdebuggerport: z.number(),
  xff: z.string(),
});

// Specific request schemas
export const StartSchema = z.object({
  tunnelID: z.string().uuid().nullable().optional(),
  tunnelConfig: TunnelConfigSchema,
});

export const StopSchema = z.object({
  tunnelID: z.string().min(1),
});

export const GetSchema = StopSchema;
export const RestartSchema = StopSchema;

export const UpdateConfigSchema = z.object({
  tunnelConfig: TunnelConfigSchema,
});

export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;

export function tunnelConfigToPinggyOptions(config: TunnelConfig): PinggyOptions {
  return {
    token: config.token || "",
    serverAddress: config.serveraddress || "free.pinggy.io",
    sniServerName: config.localservertlssni || "",
    forwardTo: `${config.forwardedhost || "localhost"}:${config.localport}`,
    debug: config.webdebuggerport > 0 ? true : false,
    debuggerPort: config.webdebuggerport || 0,
    type: config.type,
    ipWhitelist: config.ipwhitelist || [],
    basicAuth: config.basicauth ? JSON.parse(config.basicauth) : "",
    bearerAuth: config.bearerauth ? [config.bearerauth] : [],
    headerModification: config.headermodification,
    xff: !!config.xff,
    httpsOnly: config.httpsOnly,
    localServerTls: config.localsservertls ? config.localservertlssni || "" : "",
    fullRequestUrl: config.fullRequestUrl,
    allowPreflight: config.allowpreflight,
    noReverseProxy: config.noReverseProxy,
    force: config.force,
  };
}

export function pinggyOptionsToTunnelConfig(opts: PinggyOptions, configid: string): TunnelConfig {
  return {
    allowpreflight: opts.allowPreflight ?? false,
    autoreconnect: true,
    basicauth: opts.basicAuth ? JSON.stringify(opts.basicAuth) : null,
    bearerauth: opts.bearerAuth?.length ? opts.bearerAuth[0] : null,
    configid: configid,
    configname: opts.type?.toUpperCase() || "Tunnel",
    force: opts.force ?? false,
    forwardedhost: opts.forwardTo?.split(":")[0] || "localhost",
    fullRequestUrl: opts.fullRequestUrl ?? false,
    headermodification: opts.headerModification || [], //structured list
    httpsOnly: opts.httpsOnly ?? false,
    internalwebdebuggerport: 0,
    ipwhitelist: opts.ipWhitelist || null,
    localport: parseInt(opts.forwardTo?.split(":")[1] || "0", 10),
    localsservertls: opts.ssl ?? false,
    localservertlssni: opts.localServerTls || null,
    regioncode: "",
    noReverseProxy: opts.noReverseProxy ?? false,
    serveraddress: opts.serverAddress || "free.pinggy.io",
    serverport: 0,
    statusCheckInterval: 0,
    token: opts.token || "",
    tunnelTimeout: 0,
    type: opts.type || "http",
    webdebuggerport: opts.debuggerPort || 0,
    xff: opts.xff ? "1" : "",
  };
}
