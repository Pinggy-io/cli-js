#!/usr/bin/env node
import { TunnelManager } from "./tunnel_manager/TunnelManager";
import { printHelpMessage } from "./cli/help";
import { cliOptions } from "./cli/options";
import { buildFinalConfig } from "./cli/buildConfig";
import { configureLogger, logger } from "./logger";
import { parseRemoteManagement } from "./remote_management/remoteManagement";
import { parseCliArgs } from "./utils/parseArgs";



async function main() {
    try {
        // Parse arguments from the command line
        const { values, positionals } = parseCliArgs(cliOptions);

        // Configure logger from CLI args
        configureLogger(values);

        if (values.help) {
            printHelpMessage();
            return;
        }
        // Remote management mode
        const parseResult = await parseRemoteManagement(values);
        if (parseResult?.ok === false) {
            logger.error("Failed to initiate remote management:", parseResult.error);
            process.exit(1);
        }

        let finalConfig;
        // Build final configuration from parsed args
        try {
            logger.debug("Building final config from CLI values and positionals", { values, positionals });
            finalConfig = buildFinalConfig(values, positionals);
        } catch (error) {
            logger.error("Failed to build final configuration:", error);
            console.error(`Error : ${error}`);
            process.exit(1);
        }
        logger.debug("Final configuration built", finalConfig);
        logger.info(`Forwarding to: ${finalConfig.forwarding}`);

        // Use the TunnelManager to start the tunnel
        const manager = TunnelManager.getInstance();
        const tunnel = manager.createTunnel(finalConfig);

        logger.info("Connecting to Pinggy...", { configId: finalConfig.configid });
        logger.info("Connecting to Pinggy...");

          manager.startTunnel(tunnel.tunnelid);

        logger.info("Tunnel status after create:", tunnel.instance.getStatus());
        console.log("Remote URLs:");
        console.log("Tunnel urls",manager.getTunnelUrls(tunnel.tunnelid));
        console.log("msg",manager.getTunnelGreetMessage(tunnel.tunnelid));
        const stats = manager.getTunnelStats(tunnel.tunnelid);
        console.log("Stats",stats);



        console.log("\nPress Ctrl+C to stop the tunnel.");

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
        console.error(`An error occurred: ${error}`);
        process.exit(1);
    }
}


main();
