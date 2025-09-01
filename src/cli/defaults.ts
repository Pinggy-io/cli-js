import { PinggyOptions } from "@pinggy/pinggy";

// Default configuration for Tunnel
export const defaultOptions: Omit<PinggyOptions, 'token'> & { token: string | undefined } = {
  token: undefined, // No default token
  serverAddress: "a.pinggy.io",
  forwardTo: "localhost:8000",
  debug: false,
  debuggerPort: 0,
  type: "http",
  ipWhitelist: [],
  basicAuth: {},
  bearerAuth: [],
  headerModification: [],
  force: true,
  xff: false,
  httpsOnly: false,
  fullRequestUrl: false,
  allowPreflight: false,
  noReverseProxy: false,
  localServerTls: undefined,
};
