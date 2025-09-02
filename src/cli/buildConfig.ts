import { PinggyOptions } from "@pinggy/pinggy";
import { defaultOptions } from "./defaults";
import { parseExtendedOptions } from "./extendedOptions";

const Tunnel = {
  Http: "http",
  Tcp: "tcp",
  Tls: "tls",
  Udp: "udp"
} as const;

type Forwarding = {
  remoteDomain?: string;
  remotePort: number;
  localDomain: string;
  localPort: number;
};

export type FinalConfig = (PinggyOptions & { configId: string }) & {
  conf?: string;
  serve?: string;
  remoteManagement?: string;
  manage?: string;
  version?: boolean;
};

const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function parseUserAndDomain(str: string) {
  let token: string | undefined;
  let type: string | undefined;
  let server: string | undefined;

  if (!str) return { token, type, server } as const;

  if (str.includes('@')) {
    const [user, domain] = str.split('@', 2);
    if (domainRegex.test(domain)) {
      server = domain;
      // parse user modifiers like token+type or just type
      const parts = user.split('+');
      for (const part of parts) {
        if ([Tunnel.Http, Tunnel.Tcp, Tunnel.Tls, Tunnel.Udp].includes(part.toLowerCase() as typeof Tunnel[keyof typeof Tunnel])) {
          type = part;
        } else if (part === 'force') {
          token = (token ? token + '+' : '') + part;
        } else {
          token = (token ? token + '+' : '') + part;
        }
      }
    }
  } else if (domainRegex.test(str)) {
    server = str;
  }
  return { token, type, server } as const;
}

function parseUsers(positionalArgs: string[], explicitToken?: string) {
  let token: string | undefined;
  let server: string | undefined;
  let type: string | undefined;
  let forceFlag = false;
  let remaining: string[] = [...positionalArgs];

  // Allow explicit token to carry user@domain 
  if (typeof explicitToken === 'string') {
    const parsed = parseUserAndDomain(explicitToken);
    if (parsed.server) server = parsed.server;
    if (parsed.type) type = parsed.type;
    if (parsed.token) token = parsed.token;
  }

  if (remaining.length > 0) {
    const first = remaining[0];
    const parsed = parseUserAndDomain(first);
    if (parsed.server) {
      server = parsed.server;
      if (parsed.type) type = parsed.type;
      if (parsed.token) {
        if (parsed.token.includes('+')) {
          const parts = parsed.token.split('+');
          const tOnly = parts.filter((p) => p !== 'force').join('+');
          if (tOnly) token = tOnly;
          if (parts.includes('force')) forceFlag = true;
        } else {
          token = parsed.token;
        }
      }
      remaining = remaining.slice(1);
    }
  }

  return { token, server, type, forceFlag, remaining } as const;
}

function parseType(finalConfig: FinalConfig, values: Record<string, unknown>, inferredType?: string) {
  const t = (inferredType || (values as any).type || finalConfig.type) as any;
  if (t === Tunnel.Http || t === Tunnel.Tcp || t === Tunnel.Tls || t === Tunnel.Udp) {
    finalConfig.type = t;
  }
}

function parseLocalPort(finalConfig: FinalConfig, values: Record<string, unknown>): Error | null {
  if (typeof (values as any).localport !== 'string') return null;
  let lp = ((values as any).localport as string).trim();

  let isHttps = false;
  if (lp.startsWith('https://')) {
    isHttps = true;
    lp = lp.replace(/^https:\/\//, '');
  } else if (lp.startsWith('http://')) {
    lp = lp.replace(/^http:\/\//, '');
  }

  const parts = lp.split(':');
  if (parts.length === 1) {
    const port = parseInt(parts[0], 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) {
      finalConfig.forwardTo = `localhost:${port}`;
      if (isHttps) finalConfig.localServerTls = "localhost";
    } else {
      return new Error('Invalid local port');
    }
  } else if (parts.length === 2) {
    const host = parts[0] || 'localhost';
    const port = parseInt(parts[1], 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) {
      finalConfig.forwardTo = `${host}:${port}`;
      if (isHttps) finalConfig.localServerTls = host;
    } else {
      return new Error('Invalid local port');
    }
  } else {
    return new Error('Invalid --localport format');
  }

  return null;
}

// Remove IPv6 Brackets
// Example: From [::1] to ::1
function removeIPv6Brackets(ip: string): string {
  if (ip.startsWith("[") && ip.endsWith("]")) {
    return ip.slice(1, -1);
  }
  return ip;
}

function parseForwarding(forwarding: string): Forwarding | Error {
  const parts = forwarding.split(':');

  // Format: 5555:localhost:6666
  if (parts.length === 3) {
    const remotePort = parseInt(parts[0], 10);
    const localDomain = removeIPv6Brackets(parts[1] || "localhost");
    const localPort = parseInt(parts[2], 10);

    if (Number.isNaN(remotePort) || remotePort <= 0 || remotePort >= 65536) {
      return new Error("remote port incorrect");
    }
    if (Number.isNaN(localPort) || localPort <= 0 || localPort >= 65536) {
      return new Error("local port incorrect");
    }

    return { remotePort, localDomain, localPort };
  }

  // Format: domain.com:5555:localhost:6666
  if (parts.length === 4) {
    const remoteDomain = removeIPv6Brackets(parts[0]);
    const remotePort = parseInt(parts[1], 10);
    const localDomain = removeIPv6Brackets(parts[2] || "localhost");
    const localPort = parseInt(parts[3], 10);

    if (Number.isNaN(remotePort) || remotePort <= 0 || remotePort >= 65536) {
      return new Error("remote port incorrect");
    }
    if (Number.isNaN(localPort) || localPort <= 0 || localPort >= 65536) {
      return new Error("local port incorrect");
    }
    return { remoteDomain, remotePort, localDomain, localPort };
  }

  return new Error("forwarding address incorrect");
}

function parseReverseTunnelAddr(finalConfig: FinalConfig, values: Record<string, unknown>) {
  if (!Array.isArray((values as any).R) || (values as any).R.length === 0) return;
  const firstR = (values as any).R[0] as string;
  const parts = firstR.split(':');
  if (parts.length === 3) {
    const host = parts[1];
    const port = parseInt(parts[2], 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) {
      finalConfig.forwardTo = `${host}:${port}`;
    } else {
      return new Error(`Invalid port number ${port}`);

    }
  } else {
    return new Error("Incorrect command line arguments: forwarding address incorrect. Please use '-h' option for help.");

  }
}

function parseLocalTunnelAddr(finalConfig: FinalConfig, values: Record<string, unknown>) {
  if (!Array.isArray((values as any).L) || (values as any).L.length === 0) return;
  const firstL = (values as any).L[0] as string;
  const parts = firstL.split(':');
  if (parts.length === 3) {
    const lp = parseInt(parts[2], 10);
    if (!Number.isNaN(lp) && lp > 0 && lp < 65536) {
      finalConfig.debug = true;
      finalConfig.debuggerPort = lp;
    } else {
      return new Error(`Invalid debugger port ${lp}`);

    }
  } else {
    return new Error("Incorrect command line arguments: web debugger address incorrect. Please use '-h' option for help.");

  }
}

function parseDebugger(finalConfig: FinalConfig, values: Record<string, unknown>) {
  let dbg = (values as any).debugger;
  if (typeof dbg !== 'string') return;
  dbg = dbg.startsWith(':') ? dbg.slice(1) : dbg;
  const d = parseInt(dbg, 10);
  if (!Number.isNaN(d) && d > 0 && d < 65536) {
    finalConfig.debug = true;
    finalConfig.debuggerPort = d;
  } else {
    return new Error('Invalid debugger port');
  }
}

function parseToken(finalConfig: FinalConfig, explicitToken?: string) {
  if (typeof explicitToken === 'string' && explicitToken) {
    finalConfig.token = explicitToken;
  }
}


function parseArgs(finalConfig: FinalConfig, remainingPositionals: string[]) {
  parseExtendedOptions(remainingPositionals, finalConfig);
}

export function buildFinalConfig(values: Record<string, unknown>, positionals: string[]): FinalConfig {
  let token: string | undefined;
  let server: string | undefined;
  let type: string | undefined;
  let forceFlag = false;


  const userParse = parseUsers(positionals, (values as any).token as string | undefined);
  token = userParse.token;
  server = userParse.server;
  type = userParse.type;
  forceFlag = userParse.forceFlag;
  const remainingPositionals: string[] = userParse.remaining;

  const finalConfig: FinalConfig = {
    ...defaultOptions,
    configId: crypto.randomUUID(),
    token: token || (typeof values.token === 'string' ? values.token : ''),
    serverAddress: server || defaultOptions.serverAddress,
    type: (type || (values as any).type || defaultOptions.type) as 'http' | 'tcp' | 'tls' | 'udp',
  };


  parseType(finalConfig, values, type);

  // Apply token
  parseToken(finalConfig, token || values.token as string | undefined);

  const dbgErr = parseDebugger(finalConfig, values);
  if (dbgErr instanceof Error) throw dbgErr;

  const lpErr = parseLocalPort(finalConfig, values);
  if (lpErr instanceof Error) throw lpErr;

  const rErr = parseReverseTunnelAddr(finalConfig, values);
  if (rErr instanceof Error) throw rErr;

  const lErr = parseLocalTunnelAddr(finalConfig, values);
  if (lErr instanceof Error) throw lErr;

  // Apply force flag if indicated via user
  if (forceFlag) finalConfig.force = true;

  // Parse positional extended options (like x:, w:, b:, k:, a:, u:, r:)
  parseArgs(finalConfig, remainingPositionals);

  return finalConfig;
}
