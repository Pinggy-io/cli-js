import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { logger } from "../logger.js";
import { parseRemoteManagement } from "../remote_management/remoteManagement.js";
import { ParsedValues } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { buildFinalConfig } from "./buildConfig.js";
import { startCli } from "./starCli.js";
import CLIPrinter from "../utils/printer.js";
import {
    printConfigList,
    printConfigDetail,
    findConfig,
    saveConfig,
    deleteConfig,
    validateName,
} from "./configStore.js";

type CliValues = ParsedValues<typeof cliOptions>;

/**
 * Handle config store commands.
 *   --ls                     → list all saved configs
 *   --rm <name|id>             → delete a saved config
 *   <name|id>                → show config details
 *   <name|id> start [...]    → start tunnel from saved config
 *
 * Returns true if a config command was handled, false if normal tunnel flow should continue.
 */
export async function handleConfigCommands(
    values: CliValues,
    positionals: string[],
    manager: TunnelManager
): Promise<boolean> {
    if (values.ls) {
        printConfigList();
        return true;
    }

    // --rm <nameOrId>
    if (values.rm) {
        const nameOrId = values.rm;
        const deletedName = deleteConfig(nameOrId);
        if (deletedName) {
            CLIPrinter.success(`Config "${deletedName}" deleted.`);
        } else {
            CLIPrinter.error(`No config found matching "${nameOrId}". Use --ls to see saved configs.`);
        }
        return true;
    }

    // "<nameOrId>" or "<nameOrId> start [...]"
    if (positionals.length >= 1) {
        const nameOrId = positionals[0];
        const saved = findConfig(nameOrId);
        if (saved) {
            const hasStart = positionals.length >= 2 && positionals[1] === "start";
            if (!hasStart) {
                printConfigDetail(saved);
                return true;
            }

            // Start tunnel from saved config; remaining positionals (after name + "start") are CLI overrides
            const remainingPositionals = positionals.slice(2);
            await initRemoteManagement(values);

            logger.debug("Building config from saved config with CLI overrides", { nameOrId });
            const finalConfig = await buildFinalConfig(values, remainingPositionals, saved.tunnelConfig);
            finalConfig.configId = saved.configId;
            logger.debug("Final configuration built from saved config", finalConfig);

            await startCli(finalConfig, manager);
            return true;
        }
    }

    return false;
}

/**
 * Build config from CLI args, optionally save it, and start the tunnel.
 */
export async function buildAndStartTunnel(
    values: CliValues,
    positionals: string[],
    manager: TunnelManager
): Promise<void> {
    await initRemoteManagement(values);

    logger.debug("Building final config from CLI values and positionals", { values, positionals });
    const finalConfig = await buildFinalConfig(values, positionals);
    logger.debug("Final configuration built", finalConfig);

    if (values.save) {
        const name = values.name;
        if (!name) {
            CLIPrinter.error("--save requires --name to specify a name for the tunnel config.");
            process.exit(1);
        }
        const nameErr = validateName(name);
        if (nameErr) {
            CLIPrinter.error(nameErr.message);
            process.exit(1);
        }
        saveConfig(name, finalConfig.configId!, finalConfig);
        CLIPrinter.success(`Config "${name}" saved.`);
    }

    await startCli(finalConfig, manager);
}

async function initRemoteManagement(values: CliValues): Promise<void> {
    const parseResult = await parseRemoteManagement(values);
    if (parseResult?.ok === false) {
        logger.error("Failed to initiate remote management:", parseResult.error);
        CLIPrinter.fatal(parseResult.error);
    }
}
