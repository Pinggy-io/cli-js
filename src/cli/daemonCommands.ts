/**
 * Daemon subcommand handlers (lifecycle only).
 *
 * Accessible via `pinggy daemon <verb>` or `pinggy d <verb>`.
 *
 * Tunnel operations (ps, stop <tunnel>) have moved to top-level commands:
 *   pinggy ps          → list running tunnels
 *   pinggy stop <name> → stop a specific tunnel
 */
import CLIPrinter from "../utils/printer.js";
import pico from "picocolors";
import { getAutoStartConfigs } from "./configStore.js";
import { startDaemon, stopDaemon, getDaemonInfo, isDaemonRunning } from "../daemon/daemonManager.js";
import { installService, uninstallService } from "../daemon/serviceInstaller.js";

// Daemon command router

export async function handleDaemon(args: string[]): Promise<void> {
    if (args.length === 0) {
        printDaemonHelp();
        return;
    }

    const verb = args[0];

    switch (verb) {
        case "start":
            await handleDaemonStart();
            return;

        case "stop":
            await handleDaemonStop();
            return;

        case "status":
            handleDaemonStatus();
            return;

        case "install-service":
        case "service-install":
            installService();
            return;

        case "uninstall-service":
        case "service-uninstall":
            uninstallService();
            return;

        // Legacy commands — point users to new top-level commands
        case "ps":
            CLIPrinter.print(pico.yellow("'pinggy daemon ps' has moved. Use: pinggy ps"));
            return;

        default:
            CLIPrinter.error(`Unknown daemon command: "${verb}"`);
            printDaemonHelp();
            return;
    }
}

// Daemon command handlers

async function handleDaemonStart(): Promise<void> {
    if (isDaemonRunning()) {
        const info = getDaemonInfo();
        CLIPrinter.print(pico.yellow(`Daemon already running (PID ${info?.pid}, port ${info?.port}).`));
        return;
    }

    // Show which tunnels will auto-start
    const autoConfigs = getAutoStartConfigs();
    if (autoConfigs.length > 0) {
        CLIPrinter.print(pico.cyanBright(`Starting daemon with ${autoConfigs.length} auto-start tunnel(s):`));
        for (const c of autoConfigs) {
            CLIPrinter.print(`  ${pico.bold(c.name)} (${c.configId.slice(0, 8)})`);
        }
    } else {
        CLIPrinter.print(pico.cyanBright("Starting daemon..."));
    }

    try {
        const info = await startDaemon();
        CLIPrinter.success(`Daemon started (PID ${info.pid}, port ${info.port}).`);
    } catch (err: any) {
        CLIPrinter.error(`Failed to start daemon: ${err.message}`);
        process.exit(1);
    }
}

async function handleDaemonStop(): Promise<void> {
    if (!isDaemonRunning()) {
        CLIPrinter.print(pico.yellow("No daemon is running."));
        return;
    }

    const result = await stopDaemon();
    if (result.ok) {
        CLIPrinter.success("Daemon stopped.");
    } else {
        CLIPrinter.error(result.error);
    }
}

function handleDaemonStatus(): void {
    const info = getDaemonInfo();
    if (!info) {
        CLIPrinter.print(pico.yellow("No daemon is running. Start with: pinggy daemon start"));
        return;
    }

    const uptimeSec = Math.floor((Date.now() - new Date(info.startedAt).getTime()) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

    CLIPrinter.print(pico.cyanBright("Daemon Status"));
    CLIPrinter.print(`  PID:       ${info.pid}`);
    CLIPrinter.print(`  Port:      ${info.port}`);
    CLIPrinter.print(`  Started:   ${info.startedAt}`);
    CLIPrinter.print(`  Uptime:    ${uptimeStr}`);
}

// Help

function printDaemonHelp(): void {
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
