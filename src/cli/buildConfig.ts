import { defaultOptions } from "./defaults.js";
import { parseExtendedOptions } from "./extendedOptions.js";
import { logger } from "../logger.js";
import { FinalConfig, Forwarding } from "../types.js";
import { ParsedValues } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { isValidPort } from "../utils/util.js";
import { v4 as uuidv4 } from "uuid";
import { TunnelType } from "@pinggy/pinggy";
import fs from "fs";
import path from "path";


const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function parseUserAndDomain(str: string) {
  let token: string | undefined;
  let type: string | undefined;
  let server: string | undefined;
  let qrCode: boolean | undefined;

  if (!str) return { token, type, server, qrCode } as const;

  if (str.includes('@')) {
    const [user, domain] = str.split('@', 2);
    if (domainRegex.test(domain)) {
      server = domain;
      // parse user modifiers like token+type or just type
      const parts = user.split('+');
      for (const part of parts) {
        if ([TunnelType.Http, TunnelType.Tcp, TunnelType.Tls, TunnelType.Udp, TunnelType.TlsTcp].includes(part.toLowerCase() as typeof TunnelType[keyof typeof TunnelType])) {
          type = part;
        } else if (part === 'force') {
          token = (token ? token + '+' : '') + part;
        } else if (part === 'qr') {
          qrCode = true;
        } else {
          token = (token ? token + '+' : '') + part;
        }
      }
    }
  } else if (domainRegex.test(str)) {
    server = str;
  }
  return { token, type, server, qrCode } as const;
}

function parseUsers(positionalArgs: string[], explicitToken?: string) {
  let token: string | undefined;
  let server: string | undefined;
  let type: string | undefined;
  let forceFlag = false;
  let qrCode = false;
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
      } if (parsed.qrCode) {
        // QR code request detected
        qrCode = true;
      }
      remaining = remaining.slice(1);
    }
  }

  return { token, server, type, forceFlag, qrCode, remaining } as const;
}

function parseType(finalConfig: FinalConfig, values: ParsedValues<typeof cliOptions>, inferredType?: string) {
  const t = inferredType || values.type || finalConfig.tunnelType;
  if (t === TunnelType.Http || t === TunnelType.Tcp || t === TunnelType.Tls || t === TunnelType.Udp) {
    finalConfig.tunnelType = [t];
  }
}

function parseLocalPort(finalConfig: FinalConfig, values: ParsedValues<typeof cliOptions>): Error | null {
  if (typeof values.localport !== 'string') return null;
  let lp = values.localport.trim();

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
    if (!Number.isNaN(port) && isValidPort(port)) {
      finalConfig.forwarding = `localhost:${port}`;
    } else {
      return new Error('Invalid local port');
    }
  } else if (parts.length === 2) {
    const host = parts[0] || 'localhost';
    const port = parseInt(parts[1], 10);
    if (!Number.isNaN(port) && isValidPort(port)) {
      finalConfig.forwarding = `${host}:${port}`;
    } else {
      return new Error('Invalid local port. Please use -h option for help.');
    }
  } else {
    return new Error('Invalid --localport format. Please use -h option for help.');
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

function ipv6SafeSplitColon(s: string): string[] {
  const result: string[] = [];
  let buf = "";
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === "[") {
      stack.push(c);
    } else if (c === "]" && stack.length > 0) {
      stack.pop();
    }

    if (c === ":" && stack.length === 0) {
      result.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }

  result.push(buf);
  return result;
}

function parseForwarding(forwarding: string): Forwarding | Error {
  const parts = ipv6SafeSplitColon(forwarding);

  // Format: 5555:localhost:6666
  if (parts.length === 3) {
    const remotePort = parseInt(parts[0], 10);
    const localDomain = removeIPv6Brackets(parts[1] || "localhost");
    const localPort = parseInt(parts[2], 10);
    return { remotePort, localDomain, localPort };
  }

  // Format: domain.com:5555:localhost:6666
  if (parts.length === 4) {
    const remoteDomain = removeIPv6Brackets(parts[0]);
    const remotePort = parseInt(parts[1], 10);
    const localDomain = removeIPv6Brackets(parts[2] || "localhost");
    const localPort = parseInt(parts[3], 10);
    return { remoteDomain, remotePort, localDomain, localPort };
  }

  return new Error("forwarding address incorrect");
}

function parseReverseTunnelAddr(finalConfig: FinalConfig, values: ParsedValues<typeof cliOptions>): Error | null {
  const reverseTunnel = values.R;

  if (!Array.isArray(reverseTunnel) || reverseTunnel.length === 0) {
    return new Error("local port not specified. Please use '-h' option for help.");
  }
  const forwarding = parseForwarding(reverseTunnel[0]);
  if (forwarding instanceof Error) {
    return forwarding;
  }
  finalConfig.forwarding = `${forwarding.localDomain}:${forwarding.localPort}`;
  // Additional forwarding
  if (reverseTunnel.length > 1) {
    finalConfig.additionalForwarding = []
    for (const t of reverseTunnel.slice(1)) {
      const f = parseForwarding(t);
      if (f instanceof Error) {
        return f;
      }
      finalConfig.additionalForwarding.push(f);
    }
  }
  return null

}

function parseLocalTunnelAddr(finalConfig: FinalConfig, values: ParsedValues<typeof cliOptions>) {
  if (!Array.isArray(values.L) || values.L.length === 0) return null;
  const firstL = values.L[0] as string;
  const parts = firstL.split(':');
  if (parts.length === 3) {
    const lp = parseInt(parts[2], 10);
    if (!Number.isNaN(lp) && isValidPort(lp)) {
      finalConfig.webDebugger = `localhost:${lp}`;
    } else {
      return new Error(`Invalid debugger port ${lp}`);

    }
  } else {
    return new Error("Incorrect command line arguments: web debugger address incorrect. Please use '-h' option for help.");

  }
}

function parseDebugger(finalConfig: FinalConfig, values: ParsedValues<typeof cliOptions>) {
  let dbg = values.debugger;
  if (typeof dbg !== 'string') return;
  dbg = dbg.startsWith(':') ? dbg.slice(1) : dbg;
  const d = parseInt(dbg, 10);
  if (!Number.isNaN(d) && isValidPort(d)) {
    finalConfig.webDebugger = `localhost:${d}`;
  } else {
    logger.error('Invalid debugger port:', dbg);
    return new Error(`Invalid debugger port ${dbg}. Please use '-h' option for help.`);
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

function storeJson(config: FinalConfig, saveconf: string | null) {
  if (saveconf) {
    const path = saveconf;
    try {
      fs.writeFileSync(path, JSON.stringify(config, null, 2), { encoding: 'utf-8', flag: 'w' });
      logger.info(`Configuration saved to ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Error loading configuration:", msg);
    }

  }
}

function loadJsonConfig(config: ParsedValues<typeof cliOptions>): FinalConfig | null {
  const configpath = config["conf"];
  if (typeof configpath === "string" && configpath.trim().length > 0) {
    const filepath = path.resolve(configpath);
    try {
      const data = fs.readFileSync(filepath, { encoding: 'utf-8' });
      const json = JSON.parse(data);
      return json;
    } catch (err) {
      logger.error("Error loading configuration:", err);
    }

  }
  return null;

}

function isSaveConfOption(values: ParsedValues<typeof cliOptions>): string | null {
  const saveconf = values["saveconf"];
  if (typeof saveconf === "string" && saveconf.trim().length > 0) {
    return saveconf;
  }
  return null;
}

export function buildFinalConfig(values: ParsedValues<typeof cliOptions>, positionals: string[]): FinalConfig {
  let token: string | undefined;
  let server: string | undefined;
  let type: string | undefined;
  let forceFlag = false;
  let qrCode = false;
  let finalConfig = new Object() as FinalConfig;
  let saveconf = isSaveConfOption(values);

  const configFromFile = loadJsonConfig(values);
  if (configFromFile !== null) {
    finalConfig = { ...configFromFile };
  }

  const userParse = parseUsers(positionals, values.token);
  token = userParse.token;
  server = userParse.server;
  type = userParse.type;
  forceFlag = userParse.forceFlag;
  qrCode = userParse.qrCode;
  const remainingPositionals: string[] = userParse.remaining;

  const initialTunnel = (type || values.type) as TunnelType;
  finalConfig = {
    ...defaultOptions,
    configid: uuidv4(),
    token: token || (typeof values.token === 'string' ? values.token : ''),
    serverAddress: server || defaultOptions.serverAddress,
    tunnelType: initialTunnel ? [initialTunnel] : defaultOptions.tunnelType,
    NoTUI: values.NoTUI || false,
    qrCode: qrCode || false,
  };


  parseType(finalConfig, values, type);

  // Apply token
  parseToken(finalConfig, token || values.token);

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

  storeJson(finalConfig, saveconf);

  return finalConfig;
}
