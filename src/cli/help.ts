import { cliOptions } from "./options";

export function printHelpMessage() {
  console.log("\nPinggy CLI Tool - Create secure tunnels to your localhost.");
  console.log("\nUsage:");
  console.log("  pinggy [options] [token@server] [tcp@server]");

  console.log("\nOptions:");
  for (const [key, value] of Object.entries(cliOptions)) {
    const short = 'short' in value && (value as any).short ? `-${(value as any).short}, ` : '    ';
    const optType = (value as any).type === 'boolean' ? '' : '<value>';
    console.log(`  ${short}--${key.padEnd(15)} ${optType.padEnd(8)} ${(value as any).description}`);
  }

  console.log("\nAdvanced Options (-x) Examples:");
  console.log("  -x:https                Enforce HTTPS only (redirect HTTP to HTTPS)");
  console.log("  -x:noreverseproxy       Disable built-in reverse-proxy header injection");
  console.log("  -x:localservertls:host  Connect to local HTTPS server with SNI");
  console.log("  -x:passpreflight        Pass CORS preflight requests unchanged");

  console.log("\nExamples (SSH-style):");
  console.log("  pinggy -R0:localhost:3000                        # Basic HTTP tunnel");
  console.log("  pinggy --type tcp -R0:localhost:22               # TCP tunnel for SSH");
  console.log("  pinggy -R0:localhost:8080 -L4300:localhost:4300  # HTTP tunnel with debugger");
  console.log("  pinggy tcp@ap.a.pinggy.io -R0:localhost:22       # TCP tunnel to Asia region");

  console.log("\nExamples (User-friendly):");
  console.log("  pinggy -p 3000                           # Basic HTTP tunnel");
  console.log("  pinggy --type tcp -p 22                  # TCP tunnel for SSH");
  console.log("  pinggy -l 8080 -d 4300                   # HTTP tunnel with debugger");
  console.log("  pinggy mytoken@a.pinggy.io -p 3000       # Authenticated tunnel");
  console.log("  pinggy -p 80 b:admin:secret              # HTTP tunnel with basic auth");
  console.log("  pinggy -p 443 x:https x:xff              # HTTPS-only with X-Forwarded-For");
  console.log("  pinggy -w:192.168.1.0/24 -p 8080         # IP whitelist restriction");
}
