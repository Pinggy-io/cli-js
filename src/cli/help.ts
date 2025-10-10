import { cliOptions } from "./options.js";

export function printHelpMessage() {
  console.log("\nPinggy CLI Tool - Create secure tunnels to your localhost.");
  console.log("\nUsage:");
  console.log("   pinggy [options] -l <port>\n");

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
  console.log("  w:192.168.1.0/24        IP whitelist (CIDR)");

  console.log("\nExamples (User-friendly):");
  console.log("  pinggy -l 3000                           # HTTP(S) tunnel to localhost port 3000");
  console.log("  pinggy --type tcp -l 22                  # TCP tunnel for SSH (port 22)");
  console.log("  pinggy -l 8080 -d 4300                   # HTTP tunnel to port 8080 with debugger running at localhost:4300");
  console.log("  pinggy --token mytoken -l 3000           # Authenticated tunnel");
  console.log("  pinggy x:https x:xff -l https://localhost:8443  # HTTPS-only + XFF");
  console.log("  pinggy w:192.168.1.0/24 -l 8080          # IP whitelist restriction");

  console.log("\nExamples (SSH-style):");
  console.log("  pinggy -R0:localhost:3000                        # Basic HTTP tunnel");
  console.log("  pinggy --type tcp -R0:localhost:22               # TCP tunnel for SSH");
  console.log("  pinggy -R0:localhost:8080 -L4300:localhost:4300  # HTTP tunnel with debugger");
  console.log("  pinggy tcp@ap.example.com -R0:localhost:22       # TCP tunnel to region\n");


}
