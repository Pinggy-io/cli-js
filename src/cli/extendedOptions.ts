import { PinggyOptions } from "@pinggy/pinggy";
import { isIP } from 'net';

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

          case "localservertls":
            config.localServerTls = value || undefined;
            break;

          case "passpreflight":
          case "allowpreflight":
            config.allowPreflight = true;
            break;

          case "noreverseproxy":
            config.noReverseProxy = true;
            break;

          case "reverseproxy":
            config.noReverseProxy = false;
            break;

          case "xff":
            config.xff = true;
            break;

          case "fullurl":
          case "fullrequesturl":
            config.fullRequestUrl = true;
            break;

          default:
            console.warn(`Warning: Unknown extended option "${key}"`);
            break;
        }
        break;
      case "w":
        // Whitelist IPs
        if (value) {
          const ips = value.split(",").map(ip => ip.trim()).filter(Boolean);
          const invalidIps = ips.filter(ip => !isValidIpV4Cidr(ip));

          if (invalidIps.length > 0) {
            console.warn(`Warning: Invalid IP/CIDR(s) in whitelist: ${invalidIps.join(", ")}`);
          }
          if (!(invalidIps.length > 0)) {
            config.ipWhitelist = ips;
          }
        } else {
          console.warn(`Warning: Extended option "${opt}" for 'w' requires IP(s)`);
        }
        break;
      case "k":
        //bearer tokens
        if (!config.bearerAuth) config.bearerAuth = [];
        if (value) {
          config.bearerAuth.push(value);
        } else {
          console.warn(`Warning: Extended option "${opt}" for 'k' requires a value`);
        }
        break;

      case "b":
        // basicauth "username:password"
        if (value && value.includes(":")) {
          const [username, password] = value.split(/:(.+)/);
          config.basicAuth = { [username]: password };
        } else {
          console.warn(`Warning: Extended option "${opt}" for 'b' requires value in format username:password`);
        }
        break;

      case "a":
        // Add header
        if (value && value.includes(":")) {
          const [key, val] = value.split(/:(.+)/);
          if (!config.headerModification) config.headerModification = [];
          config.headerModification.push({ action: "add", key, value: val });
        } else {
          console.warn(`Warning: Extended option "${opt}" for 'a' requires key:value`);
        }
        break;
      case "u":
        // Update header
        if (value && value.includes(":")) {
          const [key, val] = value.split(/:(.+)/);
          if (!config.headerModification) config.headerModification = [];
          config.headerModification.push({ action: "update", key, value: val });
        } else {
          console.warn(`Warning: Extended option "${opt}" for 'u' requires key:value`);
        }
        break;
      case "r":
        // Remove header
        if (value) {
          if (!config.headerModification) config.headerModification = [];
          config.headerModification.push({ action: "remove", key: value });
        } else {
          console.warn(`Warning: Extended option "${opt}" for 'r' requires a key`);
        }
        break;
      default:
        console.warn(`Warning: Unknown extended option "${key}"`);
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
