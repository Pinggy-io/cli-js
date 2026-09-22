
export function printDaemonHelp(): void {
    console.log("\nUsage: pinggy daemon <command>");
    console.log("       pinggy d <command>\n");
    console.log("Commands:");
    console.log("  start                    Start the daemon process");
    console.log("  stop                     Stop the daemon (stops all tunnels)");
    console.log("  status                   Show daemon PID and uptime");
    console.log("Tunnel operations:");
    console.log("  pinggy ps                List running tunnels");
    console.log("  pinggy stop <name|id>    Stop a specific tunnel");
    console.log("  pinggy attach <name|id>  Re-attach TUI to a tunnel\n");
}

export function printLogHelp(): void {
    console.log("\nUsage: pinggy log <verb> [options]\n");
    console.log("Commands:");
    console.log("  level                    Print current log level");
    console.log("  level debug|info|error   Set log level");
    console.log("  path                     Print daemon log path");
    console.log("  path <name|id>           Print tunnel log path\n");
}
export function printConfigHelp(): void {
    console.log("\nUsage: pinggy config <command> [name] [options]\n");
    console.log("Commands:");
    console.log("  list                           List all saved configs");
    console.log("  show <name>                    Show config details");
    console.log("  save <name> [tunnel flags]     Save a tunnel config");
    console.log("  update <name> [tunnel flags]   Update a saved config");
    console.log("  delete <name>                  Delete a saved config");
    console.log("  auto <name>                    Enable auto-start");
    console.log("  noauto <name>                  Disable auto-start\n");
}

export function printStartHelp(): void {
    console.log("\nUsage: pinggy start <name> [options]\n");
    console.log("Examples:");
    console.log("  pinggy start my-tunnel                Start a saved tunnel");
    console.log("  pinggy start my-tunnel -l 4000        Start with override");
    console.log("  pinggy start tunnela tunnelb           Start multiple tunnels");
    console.log("  pinggy start --all                     Start all auto-start tunnels\n");
}

export function printDevicesHelp(): void {
    console.log("\nUsage: pinggy devices <command> [options]\n");
    console.log("Run this machine as a Pinggy device.\n");
    console.log("Commands:");
    console.log("  connect --token <TOKEN>  Enrol, then stay connected until interrupted");
    console.log("  status                   Show what this machine remembers about its enrolment");
    console.log("  remove                   Forget the local credential (does not delete the device)\n");
    console.log("Options:");
    console.log("  --token <TOKEN>          Device token from the dashboard");
    console.log("  --manage <HOST>          Dashboard address. Default: dashboard.pinggy.io\n");
}
