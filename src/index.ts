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
import { TunnelOperations, TunnelResponse } from "./remote_management/handler.js";
import { fileURLToPath } from 'url';
import { argv } from 'process';
import { realpathSync } from 'fs';
import { enablePackageLogging } from "./logger.js"
import { getRemoteManagementState, initiateRemoteManagement, closeRemoteManagement } from "./remote_management/remoteManagement.js";

export { TunnelManager, TunnelOperations, TunnelResponse, enablePackageLogging, getRemoteManagementState, initiateRemoteManagement, closeRemoteManagement };

async function main() {
    try {
        // Parse arguments from the command line
        const { values, positionals, hasAnyArgs } = parseCliArgs(cliOptions);

        // Configure logger from CLI args
        configureLogger(values);

        // Use the TunnelManager to start the tunnel
        const manager = TunnelManager.getInstance();

        // Keep the process alive and handle graceful shutdown
        process.on('SIGINT', () => {
            logger.info("SIGINT received: stopping tunnels and exiting");
            console.log("\nStopping all tunnels...");
            manager.stopAllTunnels();
            console.log("Tunnels stopped. Exiting.");
            process.exit(0);
        });

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
        const finalConfig = await buildFinalConfig(values, positionals);
        logger.debug("Final configuration built", finalConfig);
        await startCli(finalConfig, manager);

    } catch (error) {
        logger.error("Unhandled error in CLI:", error);
        CLIPrinter.error(error);
    }
}

// Resolve the absolute path of the current module file.
const currentFile = fileURLToPath(import.meta.url);

let entryFile: string | null = null;

try {
    // Resolve the absolute path of the file Node was asked to execute.
    entryFile = argv[1] ? realpathSync(argv[1]) : null;
} catch (e) {
    entryFile = null;
}

// If this file executed directly from Node then only run main() 
// otherwise (if imported as module), do nothing.
if (entryFile && entryFile === currentFile) {
    main();
}
