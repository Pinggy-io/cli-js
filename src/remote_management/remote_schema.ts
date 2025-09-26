import { PinggyOptions, TunnelType } from "@pinggy/pinggy";
import { z } from "zod";


export const HeaderModificationSchema = z.object({
  key: z.string(),
  value: z.array(z.string()).optional(),
  type: z.enum(["add", "remove", "update"]),
});

// TunnelConfig schema
export const TunnelConfigSchema = z.object({
  allowpreflight: z.boolean(),
  autoreconnect: z.boolean(),
  basicauth: z.array(z.object({ username: z.string(), password: z.string() })).nullable(),
  bearerauth: z.string().nullable(),
  configid: z.string().uuid(),
  configname: z.string(),
  greetmsg: z.string().optional(),
  force: z.boolean(),
  forwardedhost: z.string(),
  fullRequestUrl: z.boolean(),
  headermodification: z.array(HeaderModificationSchema),
  httpsOnly: z.boolean(),
  internalwebdebuggerport: z.number(),
  ipwhitelist: z.array(z.string()).nullable(),
  localport: z.number(),
  localsservertls: z.union([z.boolean(), z.string()]),
  localservertlssni: z.string().nullable(),
  regioncode: z.string(),
  noReverseProxy: z.boolean(),
  serveraddress: z.string(),
  serverport: z.number(),
  statusCheckInterval: z.number(),
  token: z.string(),
  tunnelTimeout: z.number(),
  type: z.enum([TunnelType.Http, TunnelType.Tcp, TunnelType.Udp, TunnelType.Tls, TunnelType.TlsTcp]),
  webdebuggerport: z.number(),
  xff: z.string(),
});

/**
 * Schema for the payload used to manage tunnels using websocket.
 *
 * @remarks
 * This schema is intended for input validation (e.g. API request bodies or remote management socket data)
 * and enforces structural and primitive constraints but does not
 * perform side effects.
 */

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
    forwarding: `${config.forwardedhost || "localhost"}:${config.localport}`,
    webDebugger: config.webdebuggerport ? `localhost:${config.webdebuggerport}` : "",
    tunnelType: Array.isArray(config.type) ? config.type : [config.type || TunnelType.Http] as TunnelType[],
    ipWhitelist: config.ipwhitelist || [],
    basicAuth: config.basicauth ? config.basicauth : [],
    bearerTokenAuth: config.bearerauth ? [config.bearerauth] : [],
    headerModification: config.headermodification,
    xForwardedFor: !!config.xff,
    httpsOnly: config.httpsOnly,
    originalRequestUrl: config.fullRequestUrl,
    allowPreflight: config.allowpreflight,
    reverseProxy: config.noReverseProxy,
    force: config.force,
    optional: {
      sniServerName: config.localservertlssni || "",
    },
  };
}

export function pinggyOptionsToTunnelConfig(opts: PinggyOptions, configid: string, configName: string, localserverTls?: string | boolean, greetMsg?: string): TunnelConfig {
  const forwarding: string = Array.isArray(opts.forwarding) ? String(opts.forwarding[0].address).replace("//", "").replace(/\/$/, "") : String(opts.forwarding).replace("//", "").replace(/\/$/, "");
  const tunnelType = Array.isArray(opts.tunnelType)
    ? opts.tunnelType[0]
    : (opts.tunnelType ?? "http");
  const parsedTokens: string[] = opts.bearerTokenAuth ? (Array.isArray(opts.bearerTokenAuth)
    ? opts.bearerTokenAuth : (JSON.parse(opts.bearerTokenAuth) as string[])) : [];
  return {
    allowpreflight: opts.allowPreflight ?? false,
    autoreconnect: true,
    basicauth: opts.basicAuth && Object.keys(opts.basicAuth).length
      ? opts.basicAuth
      : null,
    bearerauth: parsedTokens.length ? parsedTokens.join(',') : null,
    configid: configid,
    configname: configName,
    greetmsg: greetMsg || "",
    force: opts.force ?? false,
    forwardedhost: forwarding?.split(":")[1] || "localhost",
    fullRequestUrl: opts.originalRequestUrl ?? false,
    headermodification: opts.headerModification || [], //structured list
    httpsOnly: opts.httpsOnly ?? false,
    internalwebdebuggerport: 0,
    ipwhitelist: opts.ipWhitelist
      ? (Array.isArray(opts.ipWhitelist)
        ? opts.ipWhitelist
        : JSON.parse(opts.ipWhitelist) as string[])
      : null,
    localport: parseInt(forwarding?.split(":")[2] || "0", 10),
    localservertlssni: null,
    regioncode: "",
    noReverseProxy: opts.reverseProxy ?? false,
    serveraddress: opts.serverAddress || "free.pinggy.io",
    serverport: 0,
    statusCheckInterval: 0,
    token: opts.token || "",
    tunnelTimeout: 0,
    type: tunnelType as TunnelType,
    webdebuggerport: Number(opts.webDebugger?.split(":")[0]) || 0,
    xff: opts.xForwardedFor ? "1" : "",
    localsservertls: localserverTls || false
  };
}
