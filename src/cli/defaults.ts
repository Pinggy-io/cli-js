import { TunnelConfigurationV1 } from "@pinggy/pinggy";

// Default configuration for Tunnel
export const defaultOptions: Omit<TunnelConfigurationV1, 'token'> & { token: string | undefined } = {
  version: "1.0",
  token: undefined, // No default token
  serverAddress: "a.pinggy.io",
  forwarding: "localhost:8000",
  webDebugger: "",
  ipWhitelist: [],
  basicAuth: [],
  bearerTokenAuth: [],
  headerModification: [],
  force: false,
  xForwardedFor: false,
  httpsOnly: false,
  originalRequestUrl: false,
  allowPreflight: false,
  reverseProxy: true,
  autoReconnect: true,
  // 0 = never give up: keep retrying every reconnectInterval until the tunnel
  // is back. Not user-configurable from the CLI on purpose.
  maxReconnectAttempts: 0,
};
