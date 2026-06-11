#!/usr/bin/env node
import { TunnelManager } from "./tunnel_manager/TunnelManager.js";
import { printHelpMessage } from "./cli/help.js";
import { cliOptions } from "./cli/options.js";
import { configureLogger, enablePackageLogging, logger } from "./logger.js";
import { parseCliArgs } from "./utils/parseArgs.js";
import CLIPrinter from "./utils/printer.js";
import { getVersion } from "./utils/util.js";
import { TunnelOperations, TunnelResponse } from "./remote_management/handler.js";
import { fileURLToPath } from 'url';
import { argv } from 'process';
import { realpathSync } from 'fs';
import { getRemoteManagementState, initiateRemoteManagement, closeRemoteManagement, RemoteManagementUnauthorizedError } from "./remote_management/remoteManagement.js";
import { buildAndStartTunnel } from "./cli/buildAndStartTunnel.js";
import { isSubcommand, handleSubcommand } from "./cli/subcommand/subcommands.js";
import { runDaemonChild, DaemonHandle, RunDaemonOptions, DaemonInfo } from "./daemon/lifecycle/daemonChild.js";
import { DaemonHost } from "./daemon/ipc/ipcRoutes.js";
import { ensureDaemonRunning, getActiveTunnelSummaries, getDaemonInfo, getInProcessDaemonHandle, isDaemonRunning, ActiveTunnelSummary } from "./daemon/lifecycle/daemonManager.js";

export { TunnelManager, TunnelOperations, TunnelResponse, enablePackageLogging, getRemoteManagementState, initiateRemoteManagement, closeRemoteManagement, RemoteManagementUnauthorizedError };
export { runDaemonChild, ensureDaemonRunning, getActiveTunnelSummaries, getDaemonInfo, getInProcessDaemonHandle, isDaemonRunning, DaemonHost };
export type { DaemonHandle, RunDaemonOptions, DaemonInfo, ActiveTunnelSummary };

async function main() {
    try {

        const rawArgs = process.argv.slice(2);
        // Parse arguments from the command line
        const { values, positionals, hasAnyArgs } = parseCliArgs(cliOptions);

    
        configureLogger(values);
        
        // Early branch: if this is the daemon child process, run daemon mode and return
        if (values["_daemon-child"]) {
            const { runDaemonChild } = await import("./daemon/lifecycle/daemonChild.js");
            await runDaemonChild();
            return;
        }

        // Subcommand mode: `pinggy config ...` or `pinggy start ...`
        if (isSubcommand(rawArgs)) {
            await handleSubcommand(rawArgs);
            return;
        }

        if (!hasAnyArgs || values.help) {
            printHelpMessage();
            return;
        }
        if (values.version) {
            CLIPrinter.print(`Pinggy CLI version: ${getVersion()}`);
            return;
        }

        // Default: build config from CLI args, optionally save, and start tunnel
        await buildAndStartTunnel(values, positionals);

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
    void main();
}
