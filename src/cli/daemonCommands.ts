/**
 * Daemon subcommand handlers.
 *
 * Accessible via `pinggy daemon <verb>` or `pinggy d <verb>`.
 */
import CLIPrinter from "../utils/printer.js";
import pico from "picocolors";
import {
    findConfig,
    getAutoStartConfigs,
} from "./configStore.js";
import { startDaemon, stopDaemon, getDaemonInfo, isDaemonRunning } from "../daemon/daemonManager.js";
import { IPCClient } from "../daemon/ipcClient.js";
import { installService, uninstallService } from "../daemon/serviceInstaller.js";

// ─── Daemon command router ────────────────────────────────────────────

export async function handleDaemon(args: string[]): Promise<void> {
    if (args.length === 0) {
        printDaemonHelp();
        return;
    }

    const verb = args[0];
    const rest = args.slice(1);

    switch (verb) {
        case "start":
            await handleDaemonStart(rest);
            return;

        case "stop":
            await handleDaemonStop();
            return;

        case "status":
            handleDaemonStatus();
            return;

        case "ps":
            await handleDaemonPs();
            return;

        case "tunnel-stop": {
            const nameOrId = rest[0];
            if (!nameOrId) {
                CLIPrinter.error("Tunnel name or ID is required. Usage: pinggy daemon tunnel-stop <name>");
                return;
            }
            await handleDaemonTunnelStop(nameOrId);
            return;
        }

        case "service-install":
            installService();
            return;

        case "service-uninstall":
            uninstallService();
            return;

        default:
            CLIPrinter.error(`Unknown daemon command: "${verb}"`);
            printDaemonHelp();
            return;
    }
}

// ─── Daemon command handlers ──────────────────────────────────────────

async function handleDaemonStart(configNames: string[] = []): Promise<void> {
    const alreadyRunning = isDaemonRunning();

    // If daemon isn't running, start it
    if (!alreadyRunning) {
        // Show which tunnels will auto-start
        const autoConfigs = getAutoStartConfigs();
        if (autoConfigs.length > 0) {
            CLIPrinter.print(pico.cyanBright(`Starting daemon with ${autoConfigs.length} auto-start tunnel(s):`));
            for (const c of autoConfigs) {
                CLIPrinter.print(`  ${pico.bold(c.name)} (${c.configId.slice(0, 8)})`);
            }
        } else if (configNames.length === 0) {
            CLIPrinter.print(pico.cyanBright("Starting daemon (no auto-start tunnels configured)..."));
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

    // If specific configs were requested, start them in the daemon via IPC
    if (configNames.length > 0) {
        const info = getDaemonInfo();
        if (!info) {
            CLIPrinter.error("Daemon is not running.");
            return;
        }

        if (alreadyRunning) {
            CLIPrinter.print(pico.cyanBright("Daemon already running. Starting tunnels..."));
        }

        const client = new IPCClient(info.port);
        for (const nameOrId of configNames) {
            const saved = findConfig(nameOrId);
            if (!saved) {
                CLIPrinter.error(`No config found matching "${nameOrId}". Skipping.`);
                continue;
            }
            try {
                const result = await client.startTunnel(saved.name);
                if ((result as any)?.error) {
                    CLIPrinter.error(`[${saved.name}] ${(result as any).error}`);
                } else {
                    CLIPrinter.success(`"${saved.name}" started in daemon.`);
                    const urls = (result as any)?.remoteurls ?? [];
                    for (const url of urls) {
                        CLIPrinter.print(`  ${pico.magentaBright(url)}`);
                    }
                }
            } catch (err: any) {
                CLIPrinter.error(`[${saved.name}] Failed: ${err.message}`);
            }
        }
    }
}

async function handleDaemonStop(): Promise<void> {
    if (!isDaemonRunning()) {
        CLIPrinter.print(pico.yellow("No daemon is running."));
        return;
    }

    const stopped = await stopDaemon();
    if (stopped) {
        CLIPrinter.success("Daemon stopped.");
    } else {
        CLIPrinter.error("Failed to stop daemon.");
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

async function handleDaemonPs(): Promise<void> {
    const info = getDaemonInfo();
    if (!info) {
        CLIPrinter.print(pico.yellow("No daemon is running. Start with: pinggy daemon start"));
        return;
    }

    try {
        const client = new IPCClient(info.port);
        const tunnels = await client.listTunnels();

        if (!Array.isArray(tunnels) || tunnels.length === 0) {
            CLIPrinter.print(pico.gray("No tunnels running in daemon."));
            return;
        }

        CLIPrinter.print(pico.cyanBright(`${tunnels.length} tunnel(s) running in daemon:\n`));
        for (const t of tunnels) {
            const state = t.status?.state ?? "unknown";
            const stateColor = state === "running" ? pico.green(state) : pico.yellow(state);
            const name = t.tunnelconfig?.name || t.tunnelconfig?.configname || t.tunnelid;
            CLIPrinter.print(`  ${pico.bold(name)}  ${stateColor}`);
            CLIPrinter.print(`    ID: ${t.tunnelid}`);
            if (t.remoteurls?.length > 0) {
                for (const url of t.remoteurls) {
                    CLIPrinter.print(`    ${pico.magentaBright(url)}`);
                }
            }
            CLIPrinter.print("");
        }
    } catch (err: any) {
        CLIPrinter.error(`Cannot connect to daemon: ${err.message}`);
    }
}

async function handleDaemonTunnelStop(nameOrId: string): Promise<void> {
    const info = getDaemonInfo();
    if (!info) {
        CLIPrinter.print(pico.yellow("No daemon is running. Start with: pinggy daemon start"));
        return;
    }

    try {
        const client = new IPCClient(info.port);

        // List tunnels and match by name or id
        const tunnels = await client.listTunnels();
        let tunnelid: string | null = null;

        if (Array.isArray(tunnels)) {
            for (const t of tunnels) {
                const tName = t.tunnelconfig?.name ?? "";
                if (t.tunnelid === nameOrId || tName === nameOrId || t.tunnelid.startsWith(nameOrId)) {
                    tunnelid = t.tunnelid;
                    break;
                }
            }
        }

        if (!tunnelid) {
            CLIPrinter.error(`No tunnel found matching "${nameOrId}". Use: pinggy daemon ps`);
            return;
        }

        const result = await client.stopTunnel(tunnelid);
        if (result && !(result as any).error) {
            CLIPrinter.success(`Tunnel "${nameOrId}" stopped.`);
        } else {
            CLIPrinter.error(`Failed to stop tunnel: ${(result as any)?.message || "Unknown error"}`);
        }
    } catch (err: any) {
        CLIPrinter.error(`Cannot connect to daemon: ${err.message}`);
    }
}

// ─── Help ─────────────────────────────────────────────────────────────

function printDaemonHelp(): void {
    console.log("\nUsage: pinggy daemon <command> [options]");
    console.log("       pinggy d <command> [options]\n");
    console.log("Commands:");
    console.log("  start [config...]        Start the daemon (optionally start named tunnels)");
    console.log("  stop                     Stop the running daemon");
    console.log("  status                   Show daemon PID and uptime");
    console.log("  ps                       List tunnels running in the daemon");
    console.log("  tunnel-stop <name>       Stop a specific tunnel in the daemon");
    console.log("  service-install          Install pinggy as a system service");
    console.log("  service-uninstall        Remove the pinggy system service\n");
}
