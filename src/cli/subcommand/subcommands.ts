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
    findConfigByName,
    listSavedConfigs,
    sanitizeName,
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
            const names = clubSpacedName(requireNames(rest, "config show"));
            for (const name of names) {
                const saved = resolveConfig(name, "config show");
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
            const names = clubSpacedName(requireNames(rest, "config delete"));
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
            const names = clubSpacedName(requireNames(rest, "config auto"));
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
            const names = clubSpacedName(requireNames(rest, "config noauto"));
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

        default: {
            // Treat the trailing args as a config name: `pinggy config my-tunnel`
            // or, joined, `pinggy config My Tunnel`.
            const names = clubSpacedName([verb, ...rest]);
            for (const name of names) {
                const saved = resolveConfig(name, "config");
                if (saved) printConfigDetail(saved);
            }
            return;
        }
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
    const saved = resolveConfig(nameOrId, "config update");
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

    // Resolve all configs (join-first so an unquoted spaced name resolves)
    const resolved: SavedTunnelConfig[] = [];
    for (const name of clubSpacedName(names)) {
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


/**
 * "Join-first" resolution for unquoted spaced names. The shell splits an
 * unquoted `My Tunnel` into ["My", "Tunnel"]; if the whole list joined by spaces
 * matches a single saved config, treat it as ONE name. Otherwise fall back to
 * the per-arg list — i.e. the multi-tunnel form where each arg is its own
 * tunnel. To address several spaced names at once, quote them or use configIds.
 */
function clubSpacedName(names: string[]): string[] {
    if (names.length > 1) {
        const joined = names.join(" ");
        if (findConfig(joined) ?? findConfigByName(joined)) {
            return [joined];
        }
    }
    return names;
}

function resolveConfig(nameOrId: string, command: string = "start"): SavedTunnelConfig | null {

    const saved = findConfig(nameOrId) ?? findConfigByName(nameOrId);
    if (saved) return saved;

    // Genuinely no exact match. On-disk filenames sanitize the name
    // (`"My Tunnel"` → `My_Tunnel_<id>.json`), so a user who types the sanitized
    // form `My_Tunnel` lands here. We never start the near-namesake for them
    // (`sanitizeName` is many-to-one — it could be a different tunnel), but we
    // surface the real name as an explicit, copy-pasteable hint.
    const sanitizedQuery = sanitizeName(nameOrId);
    const suggestions = listSavedConfigs().filter(
        (c) => c.name !== nameOrId && sanitizeName(c.name) === sanitizedQuery
    );

    CLIPrinter.error(`No config found matching "${nameOrId}".`);
    if (suggestions.length > 0) {
        for (const c of suggestions.slice(0, 3)) {
            CLIPrinter.info(`  Did you mean "${c.name}"?  →  pinggy ${command} "${c.name}"`);
        }
        if (suggestions.length > 3) {
            CLIPrinter.info(`  …and ${suggestions.length - 3} more. Use: pinggy config list`);
        }
    } else {
        CLIPrinter.info("  Use: pinggy config list");
    }
    return null;
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



