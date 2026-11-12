
export function printDaemonHelp(): void {
    console.log("\nUsage: pinggy daemon <command>");
    console.log("       pinggy d <command>\n");
    console.log("Commands:");
    console.log("  start                    Start the daemon process");
    console.log("  stop                     Stop the daemon (stops all tunnels)");
    console.log("  status                   Show daemon PID and uptime");
    console.log("  service-install          Run the daemon at login as a system service");
    console.log("  service-uninstall        Stop the daemon and remove the system service");
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

export function printDeviceHelp(): void {
    console.log("\nUsage: pinggy device <command> [options]\n");
    console.log("Run this machine as a Pinggy device.\n");
    console.log("Commands:");
    console.log("  login                    Sign this machine in with your email, then run the agent in the");
    console.log("                           background");
    console.log("  connect --token <TOKEN>  Enrol with a token from the dashboard, then run the agent in the");
    console.log("                           background. Without --token: start the enrolled device's agent again");
    console.log("  stop                     Stop the agent running in the background, until the daemon");
    console.log("                           starts again");
    console.log("  status                   Show whether the agent runs, the enrolment, and the background agent");
    console.log("  remove                   Stop the agent and forget the local credential, after asking.");
    console.log("                           The device stays in the dashboard\n");
    console.log("By default the agent runs in the daemon, and stays connected after this terminal closes.");
    console.log("Each time the daemon starts, it starts the agent again, until remove.\n");
    console.log("Options:");
    console.log("  --foreground             login and connect: run the agent in this terminal until Ctrl+C");
    console.log("  -b                       login and connect: run the agent in the background. The default");
    console.log("  --token <TOKEN>          Device token from the dashboard");
    console.log("  --manage <HOST>          Dashboard address. Default: dashboard.pinggy.io");
    console.log("  --name <NAME>            login only: the device's name. Default: this machine's hostname");
    console.log("  -f                       remove only: remove without asking\n");
    console.log("Environment:");
    console.log("  DEVICE_AGENT_TOKEN       connect only: the device token, when --token is not given. With no");
    console.log("                           --manage, it dials dashboard.pinggy.io. Removed once read\n");
}

export function printUpdateHelp(): void {
    console.log("\nUsage: pinggy update [--check | --rollback]\n");
    console.log("Commands:");
    console.log("  pinggy update            Update to the latest version now");
    console.log("  pinggy update --check    Print the latest version and change nothing");
    console.log("  pinggy update --rollback Go back to the previous version\n");
}
