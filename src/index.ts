#!/usr/bin/env node
import { TunnelManager } from "./tunnel_manager/TunnelManager.js";
import { printHelpMessage } from "./cli/help.js";
import { cliOptions } from "./cli/options.js";
import { buildFinalConfig } from "./cli/buildConfig.js";
import { configureLogger, logger } from "./logger.js";
import { parseRemoteManagement } from "./remote_management/remoteManagement.js";
import { parseCliArgs } from "./utils/parseArgs.js";
import CLIPrinter from "./utils/printer.js";
import { startCli } from "./cli/starCli.js";
import { getVersion } from "./utils/util.js";


async function main() {
    try {
        // Parse arguments from the command line
        const { values, positionals, hasAnyArgs } = parseCliArgs(cliOptions);

        // Configure logger from CLI args
        configureLogger(values);

        if (!hasAnyArgs || values.help) {
            printHelpMessage();
            return;
        }
        if (values.version) {
            CLIPrinter.print(`Pinggy CLI version: ${getVersion()}`);
            return;
        }

        // Remote management mode
        const parseResult = await parseRemoteManagement(values);
        if (parseResult?.ok === false) {
            CLIPrinter.error(parseResult.error);
            logger.error("Failed to initiate remote management:", parseResult.error);
            process.exit(1);
        }


        // Build final configuration from parsed args
        logger.debug("Building final config from CLI values and positionals", { values, positionals });
        const finalConfig = buildFinalConfig(values, positionals);
        logger.debug("Final configuration built", finalConfig);

        // Use the TunnelManager to start the tunnel
        const manager = TunnelManager.getInstance();
        const tunnel = await startCli(finalConfig, manager);

        // Keep the process alive and handle graceful shutdown
        process.on('SIGINT', () => {
            logger.info("SIGINT received: stopping tunnels and exiting");
            console.log("\nStopping all tunnels...");
            manager.stopAllTunnels();
            console.log("Tunnels stopped. Exiting.");
            process.exit(0);
        });

    } catch (error) {
        logger.error("Unhandled error in CLI:", error);
        CLIPrinter.error(error);
    }
}


main();
