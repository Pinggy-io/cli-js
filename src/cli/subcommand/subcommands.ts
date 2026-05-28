/**
 * Subcommand router.
 *
 * Detects `config`, `start`, `daemon` (or `d`) as the first positional
 * and routes directly to handler functions. 
 *
 */
import { cliOptions } from "../options.js";
import { parseCliArgs } from "../../utils/parseArgs.js";
import { buildFinalConfig } from "../buildConfig.js";
import CLIPrinter from "../../utils/printer.js";
import { configureLogger, logger } from "../../logger.js";
import {
    printConfigList,
    printConfigDetail,
    findConfig,
    saveConfig,
    deleteConfig,
    validateName,
    updateConfigAutoStart,
    updateTunnelConfig,
    SavedTunnelConfig,
    SUBCOMMANDS,
    Subcommand,
    ConfigVerb,
} from "../configStore.js";
import { startRemoteManagement, buildRemoteManagementWsUrl } from "../../remote_management/remoteManagement.js";
import { daemonLostMessage } from "../../utils/daemonLostMessage.js";
import { handleDaemon } from "./handlers/daemonCommandsHandler.js";
import { handlePs } from "./handlers/psCommand.js";
import { handleStop } from "./handlers/stopCommand.js";
import { handleAttach } from "./handlers/attachCommand.js";
import { handleLogs } from "./handlers/logsCommand.js";
import { handleLog } from "./handlers/logCommand.js";
import { handleRestart } from "./handlers/restartCommand.js";
import { TunnelClient } from "../../daemon/tunnelClient.js";
import {
    startForegroundViaDaemon,
    startMultipleForegroundViaDaemon,
    startBackgroundTunnels,
    startAutoStartTunnels,
} from "../startCli.js";
import { printConfigHelp, printStartHelp } from "../../utils/helpMessages.js";

const SUBCOMMAND_SET = new Set<string>(SUBCOMMANDS);

export function isSubcommand(rawArgs: string[]): boolean {
    return rawArgs.length > 0 && SUBCOMMAND_SET.has(rawArgs[0]);
}

/**
 * Route and execute a subcommand.
 */
export async function handleSubcommand(rawArgs: string[]): Promise<void> {
    const sub = rawArgs[0];
    const rest = rawArgs.slice(1);

    switch (sub as Subcommand) {
        case Subcommand.Config:
            handleConfig(rest);
            return;
        case Subcommand.Start:
            await handleStart(rest);
            return;
        case Subcommand.Stop:
            await handleStop(rest);
            return;
        case Subcommand.Ps:
            await handlePs();
            return;
        case Subcommand.Attach:
            await handleAttach(rest);
            return;
        case Subcommand.Daemon:
        case Subcommand.DaemonAlias:
            await handleDaemon(rest);
            return;
        case Subcommand.Logs: {
            const follow = rest.includes("-f");
            const nonFlagArgs = rest.filter((a) => a !== "-f");
            await handleLogs(nonFlagArgs, follow);
            return;
        }
        case Subcommand.Log:
            await handleLog(rest);
            return;
        case Subcommand.Restart:
            await handleRestart(rest);
            return;
    }
}


 function handleConfig(args: string[]): void {
    if (args.length === 0) {
        printConfigHelp();
        return;
    }

    const verb = args[0];
    const rest = args.slice(1);

    switch (verb as ConfigVerb) {
        case ConfigVerb.List:
        case ConfigVerb.Ls:
            printConfigList();
            return;

        case ConfigVerb.Show: {
            const names = requireNames(rest, "config show");
            for (const name of names) {
                const saved = resolveConfig(name);
                if (saved) printConfigDetail(saved);
            }
            return;
        }

        case ConfigVerb.Save: {
            const name = requireName(rest, "config save");
            handleConfigSave(name, rest.slice(1));
            return;
        }

        case ConfigVerb.Delete: {
            const names = requireNames(rest, "config delete");
            for (const name of names) {
                const deletedName = deleteConfig(name);
                if (deletedName) {
                    CLIPrinter.success(`Config "${deletedName}" deleted.`);
                } else {
                    CLIPrinter.error(`No config found matching "${name}". Use: pinggy config list`);
                }
            }
            return;
        }

        case ConfigVerb.Update: {
            const name = requireName(rest, "config update");
            handleConfigUpdate(name, rest.slice(1));
            return;
        }

        case ConfigVerb.Auto: {
            const names = requireNames(rest, "config auto");
            for (const name of names) {
                const updated = updateConfigAutoStart(name, true);
                if (updated) {
                    CLIPrinter.success(`Config "${updated.name}" auto-start set to on.`);
                } else {
                    CLIPrinter.error(`No config found matching "${name}". Use: pinggy config list`);
                }
            }
            return;
        }

        case ConfigVerb.Noauto: {
            const names = requireNames(rest, "config noauto");
            for (const name of names) {
                const updated = updateConfigAutoStart(name, false);
                if (updated) {
                    CLIPrinter.success(`Config "${updated.name}" auto-start set to off.`);
                } else {
                    CLIPrinter.error(`No config found matching "${name}". Use: pinggy config list`);
                }
            }
            return;
        }

        default:
            // Treat unknown verb as a config name: `pinggy config my-tunnel`
            const saved = resolveConfig(verb);
            if (saved) printConfigDetail(saved);
            return;
    }
}

 function handleConfigSave(name: string, remainingArgs: string[]): void {
    const nameErr = validateName(name);
    if (nameErr) {
        CLIPrinter.error(nameErr.message);
        process.exit(1);
    }

    // Parse remaining args as tunnel flags
    const { values, positionals } = parseCliArgs(cliOptions, remainingArgs);
    const autoStart = !!values.auto;

    logger.debug("Building config for save", { name, values, positionals });
    const finalConfig = buildFinalConfig(values, positionals);
    finalConfig.name = name;

    saveConfig(name, finalConfig.configId!, finalConfig, autoStart);
    CLIPrinter.success(`Config "${name}" saved.`);
}

 function handleConfigUpdate(nameOrId: string, remainingArgs: string[]): void {
    const saved = resolveConfig(nameOrId);
    if (!saved) return;

    // Parse remaining args as tunnel overrides
    const { values, positionals } = parseCliArgs(cliOptions, remainingArgs);

    logger.debug("Building updated config", { nameOrId, values, positionals });
    const updatedConfig = buildFinalConfig(values, positionals, saved.tunnelConfig);
    updatedConfig.name = saved.name;
    const result = updateTunnelConfig(nameOrId, updatedConfig);
    if (result) {
        CLIPrinter.success(`Config "${result.name}" updated.`);
        printConfigDetail(result);
    } else {
        CLIPrinter.error(`Failed to update config "${nameOrId}".`);
    }
}

async function handleStart(args: string[]): Promise<void> {
    // Collect tunnel names (everything before the first flag)
    const names: string[] = [];
    let i = 0;
    while (i < args.length && !args[i].startsWith("-")) {
        names.push(args[i]);
        i++;
    }
    const flagArgs = args.slice(i);

    const { values, positionals } = parseCliArgs(cliOptions, flagArgs);
    configureLogger(values);

    if (values.all) {
        await initRemoteManagementBackground(values);
        await startAutoStartTunnels();
        return;
    }

    if (names.length === 0) {
        printStartHelp();
        return;
    }

    // Resolve all configs
    const resolved: SavedTunnelConfig[] = [];
    for (const name of names) {
        const saved = resolveConfig(name);
        if (!saved) return;
        resolved.push(saved);
    }

    // Multiple tunnels + override flags → error
    if (resolved.length > 1 && flagArgs.length > 0) {
        CLIPrinter.error("Runtime overrides (-l, --type, etc.) can only be used when starting a single tunnel.");
        CLIPrinter.print("  Start one tunnel:  pinggy start my-tunnel -l 4000");
        CLIPrinter.print("  Or update first:   pinggy config update my-tunnel -l 4000");
        return;
    }

    await initRemoteManagementBackground(values);

    // Background mode: route through daemon
    if (values.b) {
        await startBackgroundTunnels(resolved, values, positionals);
        return;
    }

    if (resolved.length === 1) {
        const saved = resolved[0];
        logger.debug("Building config with overrides", { name: saved.name });
        const finalConfig = buildFinalConfig(values, positionals, saved.tunnelConfig);

        await startForegroundViaDaemon(finalConfig);
    } else {
        await startMultipleForegroundViaDaemon(resolved, values, positionals);
    }
}


function resolveConfig(nameOrId: string): SavedTunnelConfig | null {
    const saved = findConfig(nameOrId);
    if (!saved) {
        CLIPrinter.error(`No config found matching "${nameOrId}". Use: pinggy config list`);
        return null;
    }
    return saved;
}

function requireName(args: string[], command: string): string {
    if (args.length === 0 || args[0].startsWith("-")) {
        CLIPrinter.error(`Tunnel name is required. Usage: pinggy ${command} <name>`);
        process.exit(1);
    }
    return args[0];
}

/**
 * Collect all non-flag args as names. At least one is required.
 */
function requireNames(args: string[], command: string): string[] {
    const names: string[] = [];
    for (const arg of args) {
        if (arg.startsWith("-")) break;
        names.push(arg);
    }
    if (names.length === 0) {
        CLIPrinter.error(`At least one tunnel name is required. Usage: pinggy ${command} <name> [name2 ...]`);
        process.exit(1);
    }

    return names;
}

type CliValues = ReturnType<typeof parseCliArgs<typeof cliOptions>>["values"];

async function initRemoteManagementBackground(values: CliValues): Promise<void> {
    const rmToken = values["remote-management"];
    if (typeof rmToken === "string" && rmToken.trim().length > 0) {
        const manageHost = values["manage"];
        try {
            // Ensure daemon is running so remote management routes tunnel ops through it
            const handler = await TunnelClient.forRemoteManagement();

            handler.onDaemonLost((reason, detail) => {
                CLIPrinter.error(daemonLostMessage(reason, detail));
                setImmediate(() => process.exit(3));
            });

            await startRemoteManagement({
                apiKey: rmToken,
                serverUrl: buildRemoteManagementWsUrl(manageHost),
            }, handler);
        } catch (e) {
            logger.error("Failed to initiate remote management:", e);
            CLIPrinter.fatal(e);
        }
    }
}



