import { ForwardingEntry, PinggyOptions, TunnelType } from "@pinggy/pinggy";
import { config, z } from "zod";
import { AdditionalForwarding } from "../types.js";
import { isValidPort } from "../utils/util.js";


export const HeaderModificationSchema = z.object({
  key: z.string(),
  value: z.array(z.string()).optional(),
  type: z.enum(["add", "remove", "update"]),
});

export const AdditionalForwardingSchema = z.object({
  remoteDomain: z.string().optional(),
  remotePort: z.number().optional(),
  localDomain: z.string(),
  localPort: z.number(),
});


// TunnelConfig schema
export const TunnelConfigSchema = z
  .object({
    allowPreflight: z.boolean().optional(),        // primary key
    allowpreflight: z.boolean().optional(),        // legacy key
    autoreconnect: z.boolean(),
    basicauth: z.array(z.object({ username: z.string(), password: z.string() })).nullable(),
    bearerauth: z.array(z.string()).nullable(),
    configid: z.string(),
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
    type: z.enum([
        TunnelType.Http,
        TunnelType.Tcp,
        TunnelType.Udp,
        TunnelType.Tls,
        TunnelType.TlsTcp
    ]),
    webdebuggerport: z.number(),
    xff: z.string(),
    additionalForwarding: z.array(AdditionalForwardingSchema).optional(),
    serve: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.allowPreflight === undefined && data.allowpreflight === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Either allowPreflight or allowpreflight is required",
        path: ["allowPreflight"],
      });
    }
  })
  .transform((data) => ({
    ...data,
    allowPreflight: data.allowPreflight ?? data.allowpreflight,
    allowpreflight: data.allowPreflight ?? data.allowpreflight,
  }));


/**
 * Schema for the payload used to manage tunnels using websocket.
 *
 * @remarks
 * This schema is intended for input validation (e.g. API request bodies or remote management socket data)
 * and enforces structural and primitive constraints but does not
 * perform side effects.
 */

export const StartSchema = z.object({
  tunnelID: z.string().nullable().optional(),
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


// V2 Schemas

export const ForwardingEntryV2Schema = z.object({
  listenAddress: z.string().optional(),
  address: z.string(),
  type: z.enum([TunnelType.Http, TunnelType.Tcp, TunnelType.Udp, TunnelType.Tls, TunnelType.TlsTcp]).optional(),
});

/**
 * V1 Tunnel Config Schema
 */
export const TunnelConfigV1Schema = z.object({
  // Meta Info
  version: z.string(),
  name: z.string(),
  configId: z.string(),

  // General tunnel configurations
  serverAddress: z.string().optional(),
  token: z.string().optional(),
  autoReconnect: z.boolean().optional(),
  reconnectInterval: z.number().optional(),
  maxReconnectAttempts: z.number().optional(),
  force: z.boolean(),
  keepAliveInterval: z.number().optional(),

  webDebugger: z.string(),

  //Forwarding
  // Either a URL string (e.g. "https://localhost:5555") or an array of forwarding entries.
  forwarding: z.union([
    z.string(),
    z.array(ForwardingEntryV2Schema),
  ]),

  // IP whitelist 
  ipWhitelist: z.array(z.string()).optional(),

  basicAuth: z
    .array(z.object({ username: z.string(), password: z.string() }))
    .optional(),
  bearerTokenAuth: z.array(z.string()).optional(),
  headerModification: z.array(HeaderModificationSchema).optional(),

  reverseProxy: z.boolean().optional(),
  xForwardedFor: z.boolean().optional(),
  httpsOnly: z.boolean().optional(),
  originalRequestUrl: z.boolean().optional(),
  allowPreflight: z.boolean().optional(),
  serve: z.string().optional(),

  optional: z.record(z.string(), z.unknown()).optional(),
});

export type TunnelConfigV1 = z.infer<typeof TunnelConfigV1Schema>;

export const StartV2Schema = z.object({
  tunnelID: z.string().nullable().optional(),
  tunnelConfig: TunnelConfigV1Schema,
})

export const UpdateConfigV2Schema = z.object({
  tunnelConfig: TunnelConfigV1Schema,
})

/**
 * Convert a V1 TunnelConfig to PinggyOptions.
 */
export function tunnelConfigV1ToPinggyOptions(config: TunnelConfigV1): PinggyOptions {

  return {
    token: config.token || "",
    serverAddress: config.serverAddress || "a.pinggy.io:443",
    forwarding: config.forwarding,
    webDebugger: config.webDebugger || "",
    ipWhitelist: config.ipWhitelist || [],
    basicAuth: config.basicAuth || [],
    bearerTokenAuth: config.bearerTokenAuth || [],
    headerModification: config.headerModification || [],
    xForwardedFor: config.xForwardedFor ?? false,
    httpsOnly: config.httpsOnly ?? false,
    originalRequestUrl: config.originalRequestUrl ?? false,
    allowPreflight: config.allowPreflight ?? false,
    reverseProxy: config.reverseProxy ?? false,
    force: config.force ?? false,
    autoReconnect: config.autoReconnect ?? false,
    optional: config.optional || {},
  };
}

/**
 * Convert PinggyOptions back to a V1 TunnelConfig.
 */
export function pinggyOptionsToTunnelConfigV1(
  opts: PinggyOptions,
  meta?: { name?: string; version?: string, configid?: string }
): TunnelConfigV1 {

  const parsedTokens: string[] = opts.bearerTokenAuth
    ? Array.isArray(opts.bearerTokenAuth)
      ? opts.bearerTokenAuth
      : (JSON.parse(opts.bearerTokenAuth) as string[])
    : [];

  return {
    version: meta?.version || "1.0",
    name: meta?.name || "",
    configId: meta?.configid || "",
    serverAddress: opts.serverAddress || "a.pinggy.io:443",
    token: opts.token || "",
    autoReconnect: opts.autoReconnect ?? true,
    force: opts.force ?? false,
    webDebugger: opts.webDebugger || "",
    forwarding: opts.forwarding ? (opts.forwarding) : "",
    ipWhitelist: opts.ipWhitelist
      ? Array.isArray(opts.ipWhitelist)
        ? opts.ipWhitelist
        : (JSON.parse(opts.ipWhitelist) as string[])
      : [],
    basicAuth:
      opts.basicAuth && Object.keys(opts.basicAuth).length
        ? opts.basicAuth
        : undefined,
    bearerTokenAuth: parsedTokens.length ? parsedTokens : undefined,
    headerModification: opts.headerModification || [],
    reverseProxy: opts.reverseProxy ?? false,
    xForwardedFor: !!opts.xForwardedFor,
    httpsOnly: opts.httpsOnly ?? false,
    originalRequestUrl: opts.originalRequestUrl ?? false,
    allowPreflight: opts.allowPreflight ?? false,
    optional: opts.optional || {},
  };
}


export function tunnelConfigToPinggyOptions(config: TunnelConfig): PinggyOptions {
  const forwardingData: ForwardingEntry[] = [];
  // Primary Forwarding Entry
  forwardingData.push({
    address: `${config.forwardedhost}:${config.localport}`,
    type: config.type || TunnelType.Http, // Default to HTTP for the primary forwarding entry
  });

  // Additional Forwarding Entries
  if (config.additionalForwarding && Array.isArray(config.additionalForwarding)) {
    config.additionalForwarding.forEach((entry) => {
      if (entry.localDomain && entry.localPort && entry.remoteDomain) {
        const listenAddress = entry.remotePort && isValidPort(entry.remotePort)
          ? `${entry.remoteDomain}:${entry.remotePort}`
          : entry.remoteDomain;
        forwardingData.push({
          address: `${entry.localDomain}:${entry.localPort}`,
          listenAddress,
          type: TunnelType.Http,
        });
      }
    });
  }


  return {
    token: config.token || "",
    serverAddress: config.serveraddress || "free.pinggy.io",
    forwarding: forwardingData,
    webDebugger: config.webdebuggerport ? `localhost:${config.webdebuggerport}` : "",
    ipWhitelist: config.ipwhitelist || [],
    basicAuth: config.basicauth ? config.basicauth : [],
    bearerTokenAuth: config.bearerauth || [],
    headerModification: config.headermodification,
    xForwardedFor: !!config.xff,
    httpsOnly: config.httpsOnly,
    originalRequestUrl: config.fullRequestUrl,
    allowPreflight: config.allowPreflight,
    reverseProxy: config.noReverseProxy,
    force: config.force,
    autoReconnect: config.autoreconnect,
    optional: {
      sniServerName: config.localservertlssni || "",
    },
  };
}

// Legacy function to convert PinggyOptions to TunnelConfig
export function pinggyOptionsToTunnelConfig(opts: PinggyOptions, configid: string, configName: string, localserverTls?: string | boolean, greetMsg?: string | null, serve?: string): TunnelConfig {

let primaryEntry: ForwardingEntry | undefined;
let additionalEntries: ForwardingEntry[] = [];

if (Array.isArray(opts.forwarding)) {
  primaryEntry =
    opts.forwarding.find(e => !e.listenAddress) ??
    opts.forwarding[0];

  additionalEntries = opts.forwarding.filter(
    e => e !== primaryEntry && Boolean(e.listenAddress)
  );
}

const forwarding: string = primaryEntry
  ? String(primaryEntry.address)
  : String(opts.forwarding);

// Parse host + port once
const [parsedForwardedHost, portStr] = forwarding.split(":");

const parsedLocalPort = parseInt(portStr, 10);

const tunnelType =
  (primaryEntry?.type as TunnelType | undefined) ??
  TunnelType.Http;

// Map additional entries
const additionalForwarding: AdditionalForwarding[] =
  additionalEntries.map(e => {
    const [localDomain, localPortStr] =
      String(e.address).split(":");

    const [remoteDomain, remotePortStr] =
      String(e.listenAddress).split(":");

    const localPort = parseInt(localPortStr, 10);
    const remotePort = parseInt(remotePortStr, 10);

    return {
      localDomain,
      localPort: isNaN(localPort) ? 0 : localPort,
      remoteDomain,
      remotePort: isNaN(remotePort) ? 0 : remotePort,
    };
  });


  const parsedTokens: string[] = opts.bearerTokenAuth ? (Array.isArray(opts.bearerTokenAuth)
    ? opts.bearerTokenAuth : (JSON.parse(opts.bearerTokenAuth) as string[])) : [];
  return {
    allowPreflight: opts.allowPreflight ?? false,
    allowpreflight: opts.allowPreflight ?? false,
    autoreconnect: opts.autoReconnect ?? false,
    basicauth: opts.basicAuth && Object.keys(opts.basicAuth).length
      ? opts.basicAuth
      : null,
    bearerauth: parsedTokens.length ? [parsedTokens.join(',')] : null,
    configid: configid,
    configname: configName,
    greetmsg: greetMsg || "",
    force: opts.force ?? false,
    forwardedhost: parsedForwardedHost || "localhost",
    fullRequestUrl: opts.originalRequestUrl ?? false,
    headermodification: opts.headerModification || [], //structured list
    httpsOnly: opts.httpsOnly ?? false,
    internalwebdebuggerport: 0,
    ipwhitelist: opts.ipWhitelist
      ? (Array.isArray(opts.ipWhitelist)
        ? opts.ipWhitelist
        : JSON.parse(opts.ipWhitelist) as string[])
      : null,
    localport: parsedLocalPort || 0,
    localservertlssni: null,
    regioncode: "",
    noReverseProxy: opts.reverseProxy ?? false,
    serveraddress: opts.serverAddress || "free.pinggy.io",
    serverport: 0,
    statusCheckInterval: 0,
    token: opts.token || "",
    tunnelTimeout: 0,
    type: tunnelType,
    webdebuggerport: Number(opts.webDebugger?.split(":")[0]) || 0,
    xff: opts.xForwardedFor ? "1" : "",
    localsservertls: localserverTls || false,
    additionalForwarding: additionalForwarding || [],
    serve: serve || "",
  };
}
