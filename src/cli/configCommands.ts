import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { logger } from "../logger.js";
import { parseRemoteManagement, startRemoteManagement, buildRemoteManagementWsUrl } from "../remote_management/remoteManagement.js";
import { ParsedValues } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { buildFinalConfig } from "./buildConfig.js";
import { startCli } from "./starCli.js";
import CLIPrinter from "../utils/printer.js";
import { FinalConfig } from "../types.js";
import pico from "picocolors";
import {
    printConfigList,
    printConfigDetail,
    findConfig,
    saveConfig,
    deleteConfig,
    validateName,
    updateConfigAutoStart,
    updateTunnelConfig,
    getAutoStartConfigs,
    SavedTunnelConfig,
} from "./configStore.js";

type CliValues = ParsedValues<typeof cliOptions>;

/**
 * Handle config store commands.
 *   --ls                              → list all saved configs
 *   --rm <name|id>                    → delete a saved config
 *   --sa                              → start all auto-start tunnels
 *   --config <name|id>                → show config details
 *   --config <name|id> --auto/--noauto → toggle auto-start
 *   --config <name|id> --start [...]  → start tunnel (with optional CLI overrides)
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

    // --sa: start all auto-start tunnels
    if (values.sa) {
        await initRemoteManagementBackground(values);
        await startAutoStartTunnels(manager);
        return true;
    }

    // --config <nameOrId> (can be specified multiple times)
    if (values.config && values.config.length > 0) {
        const configNames = values.config;

        // Resolve all configs first
        const resolvedConfigs: { nameOrId: string; saved: SavedTunnelConfig }[] = [];
        for (const nameOrId of configNames) {
            const saved = findConfig(nameOrId);
            if (!saved) {
                CLIPrinter.error(`No config found matching "${nameOrId}". Use --ls to see saved configs.`);
                return true;
            }
            resolvedConfigs.push({ nameOrId, saved });
        }

        // --auto / --noauto toggle on all specified configs
        if (values.auto || values.noauto) {
            const autoStart = !!values.auto;
            for (const { nameOrId } of resolvedConfigs) {
                const updated = updateConfigAutoStart(nameOrId, autoStart);
                if (updated) {
                    CLIPrinter.success(`Config "${updated.name}" auto-start set to ${autoStart ? "on" : "off"}.`);
                }
            }
            return true;
        }

        // --update: update saved config with provided CLI arguments
        if (values.update) {
            if (resolvedConfigs.length !== 1) {
                CLIPrinter.error("--update can only be used with a single --config.");
                return true;
            }
            const { nameOrId, saved } = resolvedConfigs[0];

            logger.debug("Building updated config from saved config with CLI overrides", { nameOrId });
            const updatedConfig = await buildFinalConfig(values, positionals, saved.tunnelConfig);

            const result = updateTunnelConfig(nameOrId, updatedConfig);
            if (result) {
                CLIPrinter.success(`Config "${result.name}" updated.`);
                printConfigDetail(result);
            } else {
                CLIPrinter.error(`Failed to update config "${nameOrId}".`);
            }
            return true;
        }

        // --start: start tunnel(s) from saved config(s)
        if (values.start) {
            if (resolvedConfigs.length === 1) {
                // Single config: use startCli with CLI overrides
                const { nameOrId, saved } = resolvedConfigs[0];
                await initRemoteManagement(values);

                logger.debug("Building config from saved config with CLI overrides", { nameOrId });
                const finalConfig = await buildFinalConfig(values, positionals, saved.tunnelConfig);
                finalConfig.configId = saved.configId;
                logger.debug("Final configuration built from saved config", finalConfig);

                await startCli(finalConfig, manager);
            } else {
                // Multiple configs: start remote management in background, then start all tunnels
                await initRemoteManagementBackground(values);
                await startNamedTunnels(resolvedConfigs.map(r => r.saved), manager);
            }
            return true;
        }

        // Default: show config details for all specified configs
        for (const { saved } of resolvedConfigs) {
            printConfigDetail(saved);
        }
        return true;
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
        const autoStart = !!values.auto;
        saveConfig(name, finalConfig.configId!, finalConfig, autoStart);
        CLIPrinter.success(`Config "${name}" saved.`);
    }

    await startCli(finalConfig, manager);
}

/**
 * Start all configs marked for auto-start.
 * Runs in noTui mode since multiple tunnels are active.
 */
async function startAutoStartTunnels(manager: TunnelManager): Promise<void> {
    const configs = getAutoStartConfigs();

    if (configs.length === 0) {
        CLIPrinter.warn("No configs marked for auto-start. Use --auto with --save or a config name.");
        return;
    }

    CLIPrinter.print(pico.cyanBright(`Starting ${configs.length} auto-start tunnel(s)...`));

    for (const saved of configs) {
        await startSavedTunnel(saved, manager);
    }

    CLIPrinter.print(pico.gray("\nAll auto-start tunnels launched. Press Ctrl+C to stop.\n"));

    // Keep process alive
    await new Promise(() => {});
}

/**
 * Start specific named tunnels.
 * Runs in noTui mode since multiple tunnels are active.
 */
async function startNamedTunnels(configs: SavedTunnelConfig[], manager: TunnelManager): Promise<void> {
    CLIPrinter.print(pico.cyanBright(`Starting ${configs.length} tunnel(s)...`));

    for (const saved of configs) {
        await startSavedTunnel(saved, manager);
    }

    CLIPrinter.print(pico.gray("\nAll tunnels launched. Press Ctrl+C to stop.\n"));

    // Keep process alive
    await new Promise(() => {});
}

async function startSavedTunnel(saved: SavedTunnelConfig, manager: TunnelManager): Promise<void> {
    const config: FinalConfig = {
        ...saved.tunnelConfig,
        configId: saved.configId,
        optional: {
            ...saved.tunnelConfig.optional,
            noTui: true,
        },
    };

    try {
        const tunnel = await manager.createTunnel(config);
        await manager.startTunnel(tunnel.tunnelid);

        const urls = await manager.getTunnelUrls(tunnel.tunnelid);
        CLIPrinter.success(`"${saved.name}" started`);
        (urls ?? []).forEach((url: string) =>
            CLIPrinter.print("  " + pico.magentaBright(url))
        );

        // Register basic listeners for reconnection and errors
        manager.registerWorkerErrorListner(tunnel.tunnelid, (_id: string, error: Error) => {
            CLIPrinter.error(`[${saved.name}] Fatal: ${error.message}`);
        });

        manager.registerDisconnectListener(tunnel.tunnelid, async (_id, error, messages) => {
            if (error) CLIPrinter.warn(`[${saved.name}] Disconnected: ${error}`);
            messages?.forEach((m) => CLIPrinter.warn(`[${saved.name}] ${m}`));
        });

        manager.registerReconnectingListener(tunnel.tunnelid, (_id, retryCnt) => {
            CLIPrinter.print(pico.gray(`[${saved.name}] Reconnecting (attempt #${retryCnt})...`));
        });

        manager.registerReconnectionCompletedListener(tunnel.tunnelid, async (_id, urls) => {
            CLIPrinter.success(`[${saved.name}] Reconnected`);
            (urls ?? []).forEach((url: string) =>
                CLIPrinter.print("  " + pico.magentaBright(url))
            );
        });

        manager.registerReconnectionFailedListener(tunnel.tunnelid, (_id, retryCnt) => {
            CLIPrinter.error(`[${saved.name}] Reconnection failed after ${retryCnt} attempts`);
        });
    } catch (err: any) {
        CLIPrinter.error(`[${saved.name}] Failed to start: ${err.message || err}`);
    }
}

async function initRemoteManagement(values: CliValues): Promise<void> {
    const parseResult = await parseRemoteManagement(values);
    if (parseResult?.ok === false) {
        logger.error("Failed to initiate remote management:", parseResult.error);
        CLIPrinter.fatal(parseResult.error);
    }
}

/**
 * Start remote management in the background (non-blocking).
 * Used by --sa so that tunnels can be started after the WS connects.
 */
async function initRemoteManagementBackground(values: CliValues): Promise<void> {
    const rmToken = values["remote-management"];
    if (typeof rmToken === "string" && rmToken.trim().length > 0) {
        const manageHost = values["manage"];
        try {
            await startRemoteManagement({
                apiKey: rmToken,
                serverUrl: buildRemoteManagementWsUrl(manageHost),
            });
        } catch (e) {
            logger.error("Failed to initiate remote management:", e);
            CLIPrinter.fatal(e);
        }
    }
}
