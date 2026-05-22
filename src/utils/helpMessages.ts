



export function printDaemonHelp(): void {
    console.log("\nUsage: pinggy daemon <command>");
    console.log("       pinggy d <command>\n");
    console.log("Commands:");
    console.log("  start                    Start the daemon process");
    console.log("  stop                     Stop the daemon (stops all tunnels)");
    console.log("  status                   Show daemon PID and uptime");
    console.log("  install-service          Install pinggy as a system service");
    console.log("  uninstall-service        Remove the pinggy system service\n");
    console.log("Tunnel operations:");
    console.log("  pinggy ps                List running tunnels");
    console.log("  pinggy stop <name|id>    Stop a specific tunnel");
    console.log("  pinggy attach <name|id>  Re-attach TUI to a tunnel\n");
}