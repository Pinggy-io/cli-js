import { cliOptions } from "./options.js";

type CliOptionEntry = {
  type: 'string' | 'boolean';
  description: string;
  short?: string;
  multiple?: boolean;
  hidden?: boolean;
};

export function printHelpMessage() {
  console.log("\nPinggy CLI Tool - Create secure tunnels to your localhost.");
  console.log("\nUsage:");
  console.log("   pinggy [options] -l <port>\n");

  console.log("Options:");
  for (const [key, rawValue] of Object.entries(cliOptions)) {
    const value = rawValue as CliOptionEntry;
    if (value.hidden) continue;
    const short = value.short ? `-${value.short}, ` : '    ';
    const optType = value.type === 'boolean' ? '' : '<value>';
    console.log(`  ${short}--${key.padEnd(17)} ${optType.padEnd(8)} ${value.description}`);
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
  console.log("  pinggy tcp@ap.example.com -R0:localhost:22       # TCP tunnel to region");

  console.log("\nConfig Management:");
  console.log("  pinggy config list                                           # List saved configs");
  console.log("  pinggy config show my-tunnel                                 # Show config details");
  console.log("  pinggy config save my-tunnel -l 3000 token@pro.pinggy.io     # Save config");
  console.log("  pinggy config save my-tunnel --auto -l 3000                  # Save with auto-start");
  console.log("  pinggy config update my-tunnel -l 4000                       # Update saved config");
  console.log("  pinggy config delete my-tunnel                               # Delete saved config");
  console.log("  pinggy config auto my-tunnel                                 # Enable auto-start");
  console.log("  pinggy config noauto my-tunnel                               # Disable auto-start");

  console.log("\nStart Saved Tunnels:");
  console.log("  pinggy start my-tunnel                                       # Start saved tunnel");
  console.log("  pinggy start my-tunnel -l 4000                               # Start with runtime overrides");
  console.log("  pinggy start tunnela tunnelb                                 # Start multiple tunnels");
  console.log("  pinggy start --all                                           # Start all auto-start tunnels\n");
  
  console.log("\nTunnel Management:");
  console.log("  pinggy ps                                                    # List running tunnels");
  console.log("  pinggy stop <name|id>                                        # Stop a running tunnel");
  console.log("  pinggy attach <name|id>                                      # Re-attach TUI to a running tunnel");
  console.log("  pinggy restart <name|id>                                     # Restart a running tunnel (picks up latest log level)");
  console.log("  pinggy logs [-f] [<name|id>]                                 # Show (or follow) tunnel or daemon logs");
  console.log("  pinggy log level [debug|info|error]                          # Get or set the log level");
  console.log("  pinggy log path [<name|id>]                                  # Print log file path");

  console.log("\nBackground Mode:");
  console.log("  pinggy -l 3000 --b                                           # Start tunnel in background");
  console.log("  pinggy start my-tunnel --b                                   # Start saved tunnel in background");

  console.log("\nDaemon Lifecycle (also: pinggy d <command>):");
  console.log("  pinggy daemon start                                          # Start the background daemon");
  console.log("  pinggy daemon stop                                           # Stop the daemon (stops all tunnels)");
  console.log("  pinggy daemon status                                         # Show daemon PID and uptime");
}
