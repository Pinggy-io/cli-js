/**
 * `pinggy log level [debug|info|error]` - Get or set daemon log level.
 * `pinggy log path [name|id]`           - Print daemon or tunnel log path.
 */
import { TunnelClient } from "../daemon/tunnelClient.js";
import CLIPrinter from "../utils/printer.js";

const VALID_LEVELS = ["debug", "info", "error"] as const;
type LogLevel = (typeof VALID_LEVELS)[number];

export async function handleLog(args: string[]): Promise<void> {
    if (args.length === 0) {
        printLogHelp();
        return;
    }

    const verb = args[0];
    const rest = args.slice(1);

    switch (verb) {
        case "level":
            await handleLogLevel(rest);
            break;
        case "path":
            await handleLogPath(rest);
            break;
        default:
            CLIPrinter.error(`Unknown log subcommand: ${verb}`);
            printLogHelp();
    }
}

async function handleLogLevel(args: string[]): Promise<void> {
    const client = new TunnelClient();
    try {
        await client.ensureDaemon();
    } catch (err: any) {
        CLIPrinter.error(`Cannot connect to daemon: ${err.message}`);
        return;
    }

    try {
        if (args.length === 0) {
            const level = await client.getLogLevel();
            CLIPrinter.print(`Log level: ${level}`);
            return;
        }

        const level = args[0].toLowerCase();
        if (!VALID_LEVELS.includes(level as LogLevel)) {
            CLIPrinter.error(`Invalid log level: "${level}". Must be one of: ${VALID_LEVELS.join(", ")}`);
            client.close();
            process.exit(1);
        }

        await client.setLogLevel(level as LogLevel);
        CLIPrinter.success(`Log level set to "${level}". Affects daemon JS logs and new tunnels. Run \`pinggy restart <name>\` to apply to a running tunnel.`);
    } catch (err: any) {
        CLIPrinter.error(`Failed to update log level: ${err.message}`);
    } finally {
        client.close();
    }
}

async function handleLogPath(args: string[]): Promise<void> {
    const client = new TunnelClient();
    try {
        await client.ensureDaemon();
    } catch (err: any) {
        CLIPrinter.error(`Cannot connect to daemon: ${err.message}`);
        return;
    }

    try {
        if (args.length === 0) {
            const paths = await client.getLogPaths();
            CLIPrinter.print(paths.daemon);
            return;
        }

        const arg = args[0];
        const result = await client.resolveLogPath(arg);

        switch (result.status) {
            case "running":
            case "historical":
                CLIPrinter.print(result.path!);
                break;
            case "config-only":
                CLIPrinter.error(`Tunnel "${arg}" is saved but has not been started yet. No logs available.`);
                client.close();
                process.exit(1);
                break;
            case "not-found":
                CLIPrinter.error(`No tunnel or log file matching "${arg}".`);
                client.close();
                process.exit(1);
                break;
        }
    } catch (err: any) {
        CLIPrinter.error(`Failed to resolve log path: ${err.message}`);
    } finally {
        client.close();
    }
}

function printLogHelp(): void {
    console.log("\nUsage: pinggy log <verb> [options]\n");
    console.log("Commands:");
    console.log("  level                    Print current log level");
    console.log("  level debug|info|error   Set log level");
    console.log("  path                     Print daemon log path");
    console.log("  path <name|id>           Print tunnel log path\n");
}
