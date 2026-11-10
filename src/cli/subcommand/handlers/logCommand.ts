/**
 * `pinggy log level [debug|info|error]` - Get or set daemon log level.
 * `pinggy log path [name|id]`           - Print daemon or tunnel log path.
 */
import { TunnelClient } from "../../../daemon/tunnelClient.js";
import { configuredLogLevel, writeDaemonConfig } from "../../../daemon/lifecycle/daemonConfig.js";
import { LogLookup, openLogLookup } from "./logLookup.js";
import { printLogHelp } from "../../../utils/helpMessages.js";
import CLIPrinter from "../../../utils/printer.js";
import { errorMessage } from "../../../utils/util.js";

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

function parseLevel(arg: string): LogLevel {
    const level = arg.toLowerCase();
    if (!VALID_LEVELS.includes(level as LogLevel)) {
        CLIPrinter.error(`Invalid log level: "${level}". Must be one of: ${VALID_LEVELS.join(", ")}`);
        process.exit(1);
    }
    return level as LogLevel;
}

// With no daemon, the level lives in daemon-config.json, and the next daemon starts with it.
function handleLogLevelWithoutDaemon(level: LogLevel | undefined): void {
    if (!level) {
        CLIPrinter.print(`Log level: ${configuredLogLevel()}`);
        return;
    }
    writeDaemonConfig({ logLevel: level });
    CLIPrinter.success(`Log level set to "${level}". The daemon uses it when it starts.`);
}

async function handleLogLevel(args: string[]): Promise<void> {
    const level = args.length > 0 ? parseLevel(args[0]) : undefined;
    const client = new TunnelClient();
    try {
        if (!client.connectIfRunning()) {
            handleLogLevelWithoutDaemon(level);
            return;
        }
    } catch (err) {
        CLIPrinter.error(`Cannot connect to daemon: ${errorMessage(err)}`);
        return;
    }

    try {
        if (!level) {
            CLIPrinter.print(`Log level: ${await client.getLogLevel()}`);
            return;
        }
        await client.setLogLevel(level);
        CLIPrinter.success(`Log level set to "${level}". Affects daemon JS logs and new tunnels. Run \`pinggy restart <name>\` to apply to a running tunnel.`);
    } catch (err) {
        CLIPrinter.error(`Failed to update log level: ${errorMessage(err)}`);
    } finally {
        client.close();
    }
}

async function handleLogPath(args: string[]): Promise<void> {
    let client: LogLookup;
    try {
        client = openLogLookup();
    } catch (err) {
        CLIPrinter.error(`Cannot connect to daemon: ${errorMessage(err)}`);
        return;
    }

    try {
        if (args.length === 0) {
            CLIPrinter.print(await client.daemonLogPath());
            return;
        }

        const arg = args[0];
        const result = await client.resolve(arg);

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
    } catch (err) {
        CLIPrinter.error(`Failed to resolve log path: ${errorMessage(err)}`);
    } finally {
        client.close();
    }
}
