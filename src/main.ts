#!/usr/bin/env node
import { TunnelManager } from "./tunnel_manager/TunnelManager.js";
import { printHelpMessage } from "./cli/help.js";
import { cliOptions } from "./cli/options.js";
import { configureLogger, logger } from "./logger.js";
import { parseCliArgs } from "./utils/parseArgs.js";
import CLIPrinter from "./utils/printer.js";
import { getVersion } from "./utils/util.js";
import { TunnelOperations, TunnelResponse } from "./remote_management/handler.js";
import { fileURLToPath } from 'url';
import { argv } from 'process';
import { realpathSync } from 'fs';
import { enablePackageLogging } from "./logger.js"
import { getRemoteManagementState, initiateRemoteManagement, closeRemoteManagement, RemoteManagementUnauthorizedError } from "./remote_management/remoteManagement.js";
import { buildAndStartTunnel } from "./cli/buildAndStartTunnel.js";
import { isSubcommand, handleSubcommand } from "./cli/subcommands.js";

export { TunnelManager, TunnelOperations, TunnelResponse, enablePackageLogging, getRemoteManagementState, initiateRemoteManagement, closeRemoteManagement, RemoteManagementUnauthorizedError };

async function main() {
    try {
        const rawArgs = process.argv.slice(2);
        const manager = TunnelManager.getInstance();

        process.on('SIGINT', () => {
            logger.info("SIGINT received: stopping tunnels and exiting");
            console.log("\nStopping all tunnels...");
            manager.stopAllTunnels();
            console.log("Tunnels stopped. Exiting.");
            process.exit(0);
        });

        // Subcommand mode: `pinggy config ...` or `pinggy start ...`
        if (isSubcommand(rawArgs)) {
            await handleSubcommand(rawArgs, manager);
            return;
        }

        // Tunnel creation mode: parse all flags
        const { values, positionals, hasAnyArgs } = parseCliArgs(cliOptions);

        configureLogger(values);

        if (!hasAnyArgs || values.help) {
            printHelpMessage();
            return;
        }
        if (values.version) {
            CLIPrinter.print(`Pinggy CLI version: ${getVersion()}`);
            return;
        }

        // Default: build config from CLI args, optionally save, and start tunnel
        await buildAndStartTunnel(values, positionals, manager);

    } catch (error) {
        logger.error("Unhandled error in CLI:", error);
        CLIPrinter.fatal(error);
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
