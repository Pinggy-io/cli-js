import { cliOptions } from "./options";

export function printHelpMessage() {
  console.log("\nPinggy CLI Tool - Create secure tunnels to your localhost.");
  console.log("\nUsage:");
  console.log("  pinggy [options] [user@domain]             # Domain can be any valid domain\n");

  console.log("Options:");
  for (const [key, value] of Object.entries(cliOptions)) {
    if ((value as any).hidden) continue;
    const short = 'short' in value && (value as any).short ? `-${(value as any).short}, ` : '    ';
    const optType = (value as any).type === 'boolean' ? '' : '<value>';
    console.log(`  ${short}--${key.padEnd(17)} ${optType.padEnd(8)} ${(value as any).description}`);
  }

  console.log("\nExtended options :");
  console.log("  x:https                 Enforce HTTPS only (redirect HTTP to HTTPS)");
  console.log("  x:noreverseproxy        Disable built-in reverse-proxy header injection");
  console.log("  x:localservertls:host   Connect to local HTTPS server with SNI");
  console.log("  x:passpreflight         Pass CORS preflight requests unchanged");
  console.log("  a:Key:Val               Add header");
  console.log("  u:Key:Val               Update header");
  console.log("  r:Key                   Remove header");
  console.log("  b:user:pass             Basic auth");
  console.log("  k:BEARER                Bearer token");
  console.log("  w:192.168.1.0/24        IP whitelist (CIDR)\n");

  console.log("Examples (SSH-style):");
  console.log("  pinggy -R0:localhost:3000                        # Basic HTTP tunnel");
  console.log("  pinggy --type tcp -R0:localhost:22               # TCP tunnel for SSH");
  console.log("  pinggy -R0:localhost:8080 -L4300:localhost:4300  # HTTP tunnel with debugger");
  console.log("  pinggy tcp@ap.example.com -R0:localhost:22       # TCP tunnel to region\n");

  console.log("Examples (User-friendly):");
  console.log("  pinggy -p 3000                           # Basic HTTP tunnel");
  console.log("  pinggy --type tcp -p 22                  # TCP tunnel for SSH");
  console.log("  pinggy -l 8080 -d 4300                   # HTTP tunnel with debugger");
  console.log("  pinggy mytoken@a.example.com -p 3000     # Authenticated tunnel");
  console.log("  pinggy x:https x:xff -l https://localhost:8443  # HTTPS-only + XFF");
  console.log("  pinggy w:192.168.1.0/24 -l 8080          # IP whitelist restriction");
}
