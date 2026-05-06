import { logger } from "../logger.js";
import { parseRemoteManagement } from "../remote_management/remoteManagement.js";
import { ParsedValues } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { buildFinalConfig } from "./buildConfig.js";
import CLIPrinter from "../utils/printer.js";
import {
    saveConfig,
    validateName,
} from "./configStore.js";
import { DaemonTunnelHandler } from "../daemon/tunnelClient.js";
import { IPCClient } from "../daemon/ipcClient.js";
import { getDaemonInfo, startDaemon } from "../daemon/daemonManager.js";
import { startForegroundViaDaemon, startBackgroundViaDaemon } from "./startCli.js";

type CliValues = ParsedValues<typeof cliOptions>;

/**
 * Build config from CLI args, optionally save it, and start the tunnel.
 * All tunnels route through the daemon process.
 */
export async function buildAndStartTunnel(
    values: CliValues,
    positionals: string[],
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

    if (values.bg) {
        await startBackgroundViaDaemon(finalConfig);
        return;
    }

    await startForegroundViaDaemon(finalConfig);
}

async function initRemoteManagement(values: CliValues): Promise<void> {
    const rmToken = values["remote-management"];
    if (typeof rmToken !== "string" || rmToken.trim().length === 0) return;

    // Ensure daemon is running so remote management can route tunnel ops through it
    const info = getDaemonInfo() ?? await startDaemon();
    const handler = new DaemonTunnelHandler(new IPCClient(info.port));

    const parseResult = await parseRemoteManagement(values, handler);
    if (parseResult?.ok === false) {
        logger.error("Failed to initiate remote management:", parseResult.error);
        CLIPrinter.fatal(parseResult.error);
    }
}
