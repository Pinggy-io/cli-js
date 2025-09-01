import { PinggyOptions } from "@pinggy/pinggy";
import { defaultOptions } from "./defaults";
import { parseExtendedOptions } from "./extendedOptions";

export type FinalConfig = PinggyOptions & { configId: string };

function parseTokenTypeServer(str: string) {
  let token: string | undefined;
  let type: string | undefined;
  let server: string | undefined;

  if (str.includes('@') && str.endsWith('.pinggy.io')) {
    const [prefix, srv] = str.split('@');
    server = srv;
    if (prefix.includes('+')) {
      const [tok, typ] = prefix.split('+');
      token = tok;
      type = typ;
    } else if (['tcp', 'tls', 'http', 'udp'].includes(prefix)) {
      type = prefix;
    } else {
      token = prefix;
    }
  } else if (str.endsWith('.pinggy.io')) {
    server = str;
  }
  return { token, type, server } as const;
}

export function buildFinalConfig(values: Record<string, unknown>, positionals: string[]): FinalConfig {
  let token: string | undefined;
  let server: string | undefined;
  let type: string | undefined;

  if (typeof values.token === "string") {
    const parsed = parseTokenTypeServer(values.token);
    if (parsed.token) token = parsed.token;
    if (parsed.type) type = parsed.type;
    if (parsed.server) server = parsed.server;
  }

  positionals.forEach((pos) => {
    const parsed = parseTokenTypeServer(pos);
    if (parsed.token) token = parsed.token;
    if (parsed.type) type = parsed.type;
    if (parsed.server) server = parsed.server;
  });

  const finalConfig: FinalConfig = {
    ...defaultOptions,
    configId: crypto.randomUUID(),
    token: token || (typeof values.token === "string" ? values.token : ""),
    serverAddress: server || defaultOptions.serverAddress,
    type: (type || (values as any).type || defaultOptions.type) as "http" | "tcp" | "tls" | "udp",
  };

  // Handle Local port to forward tunnels
  if (values.R && (values.R as string[]).length > 0) {
    const firstR = (values.R as string[])[0];
    if (firstR && firstR.includes('localhost')) {
      const parts = firstR.split(':');
      // If format is remotePort:host:port, take host:port
      if (parts.length === 3 && parseInt(parts[2], 10) > 0 && parseInt(parts[2], 10) < 65535) {
        finalConfig.forwardTo = `${parts[1]}:${parts[2]}`;
      } else {
        console.warn("Invalid port number")
        process.exit(1)
      }
    } else {
      console.log("Incorrect command line arguments: forwarding address incorrect. Please use '-h' option for help.")
      process.exit(1);
    }
  }

  // Handles webdebugger
  if (values.L && (values.L as string[]).length > 0) {
    const firstL = (values.L as string[])[0];
    if (firstL && firstL.includes('localhost')) {
      const parts = firstL.split(':');
      // If format is remotePort:host:port, take host:port
      if (parts.length === 3 && parseInt(parts[2], 10) > 0 && parseInt(parts[2], 10) < 65535) {
        finalConfig.debug = true;
        finalConfig.debuggerPort = parseInt(parts[2], 10);
      } else {
        console.warn("Invalid port number")
        process.exit(1)
      }
    } else {
      console.log("Incorrect command line arguments: webdebugger address incorrect. Please use '-h' option for help.")
      process.exit(1);
    }
  }

  // Parse positional extended options.
  parseExtendedOptions(positionals, finalConfig);

  return finalConfig;
}
