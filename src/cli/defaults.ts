import { TunnelConfigurationV1 } from "@pinggy/pinggy";

// Default configuration for Tunnel
export const defaultOptions: Omit<TunnelConfigurationV1, 'token'> & { token: string | undefined } = {
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
  reverseProxy: false,
  autoReconnect: true,
};
