import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { logger } from "../logger.js";
import { parseRemoteManagement } from "../remote_management/remoteManagement.js";
import { ParsedValues } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { buildFinalConfig } from "./buildConfig.js";
import { startCli } from "./starCli.js";
import CLIPrinter from "../utils/printer.js";
import {
    saveConfig,
    validateName,
} from "./configStore.js";

type CliValues = ParsedValues<typeof cliOptions>;

/**
 * Build config from CLI args, optionally save it, and start the tunnel.
 * This is the default flow when no subcommand is used.
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

async function initRemoteManagement(values: CliValues): Promise<void> {
    const parseResult = await parseRemoteManagement(values);
    if (parseResult?.ok === false) {
        logger.error("Failed to initiate remote management:", parseResult.error);
        CLIPrinter.fatal(parseResult.error);
    }
}
