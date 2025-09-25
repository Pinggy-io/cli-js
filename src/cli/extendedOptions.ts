import { PinggyOptions } from "@pinggy/pinggy";
import { isIP } from 'net';
import { logger } from "../logger";
import CLIPrinter from "../utils/printer";

export function parseExtendedOptions(options: string[] | undefined, config: PinggyOptions) {
  if (!options) return;

  for (const opt of options) {
    const [key, value] = opt.replace(/^"|"$/g, "").split(/:(.+)/).filter(Boolean);

    switch (key) {
      case "x":
        switch (value) {
          case "https":
          case "httpsonly":
            config.httpsOnly = true;
            break;
            
          case "passpreflight":
          case "allowpreflight":
            config.allowPreflight = true;
            break;

          case "reverseproxy":
            config.reverseProxy = false;
            break;

          case "xff":
            config.xForwardedFor = true;
            break;

          case "fullurl":
          case "fullrequesturl":
            config.originalRequestUrl = true;
            break;

          default:
            CLIPrinter.warn(`Unknown extended option "${key}"`);
            logger.warn(`Warning: Unknown extended option "${key}"`);
            break;
        }
        break;
      case "w":
        // Whitelist IPs
        if (value) {
          const ips = value.split(",").map(ip => ip.trim()).filter(Boolean);
          const invalidIps = ips.filter(ip => !isValidIpV4Cidr(ip));

          if (invalidIps.length > 0) {
            CLIPrinter.warn(`Invalid IP/CIDR(s) in whitelist: ${invalidIps.join(", ")}`);
            logger.warn(`Warning: Invalid IP/CIDR(s) in whitelist: ${invalidIps.join(", ")}`);
          }
          if (!(invalidIps.length > 0)) {
            config.ipWhitelist = ips;
          }
        } else {
          CLIPrinter.warn(`Extended option "${opt}" for 'w' requires IP(s)`);
          logger.warn(`Warning: Extended option "${opt}" for 'w' requires IP(s)`);
        }
        break;
      case "k":
        //bearer tokens
        if (!config.bearerTokenAuth) config.bearerTokenAuth = [];
        if (value) {
          config.bearerTokenAuth.push(value);
        } else {
          CLIPrinter.warn(`Extended option "${opt}" for 'k' requires a value`);
          logger.warn(`Warning: Extended option "${opt}" for 'k' requires a value`);
        }
        break;

      case "b":
        // basicauth "username:password"
        if (value && value.includes(":")) {
          const [username, password] = value.split(/:(.+)/);
          if (!config.basicAuth) config.basicAuth = [];
          config.basicAuth.push({ username, password });
        } else {
          CLIPrinter.warn(`Extended option "${opt}" for 'b' requires value in format username:password`);
          logger.warn(`Warning: Extended option "${opt}" for 'b' requires value in format username:password`);
        }
        break;

      case "a":
        // Add header
        if (value && value.includes(":")) {
          const [key, val] = value.split(/:(.+)/);
          if (!config.headerModification) config.headerModification = [];
          config.headerModification.push({ type: "add", key, value: [val] });
        } else {
          CLIPrinter.warn(`Extended option "${opt}" for 'a' requires key:value`);
          logger.warn(`Warning: Extended option "${opt}" for 'a' requires key:value`);
        }
        break;
      case "u":
        // Update header
        if (value && value.includes(":")) {
          const [key, val] = value.split(/:(.+)/);
          if (!config.headerModification) config.headerModification = [];
          config.headerModification.push({ type: "update", key, value: [val] });
        } else {
          CLIPrinter.warn(`Extended option "${opt}" for 'u' requires key:value`);
          logger.warn(`Warning: Extended option "${opt}" for 'u' requires key:value`);
        }
        break;
      case "r":
        // Remove header
        if (value) {
          if (!config.headerModification) config.headerModification = [];
          config.headerModification.push({ type: "remove", key: value });
        } else {
          CLIPrinter.warn(`Extended option "${opt}" for 'r' requires a key`);
        }
        break;
      default:
        CLIPrinter.warn(`Unknown extended option "${key}"`);
        break;
    }
  }
}

function isValidIpV4Cidr(input: string): boolean {
  // Check for CIDR notation
  if (input.includes('/')) {
    const [ip, mask] = input.split('/');
    if (!ip || !mask) return false;
    const isIp4 = isIP(ip) === 4;
    const maskNum = parseInt(mask, 10);
    const isMaskValid = !isNaN(maskNum) && maskNum >= 0 && maskNum <= 32;
    return isIp4 && isMaskValid;
  }
  return false;
}
