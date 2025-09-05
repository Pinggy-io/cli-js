#!/usr/bin/env node
import { parseArgs } from "util";
import { TunnelManager } from "./tunnel_manager/TunnelManager";
import { printHelpMessage } from "./cli/help";
import { cliOptions } from "./cli/options";
import { buildFinalConfig } from "./cli/buildConfig";
import { configureLogger, logger } from "./logger";
import { parseRemoteManagement } from "./cli/remoteManagement";


async function main() {
    try {
        // Parse arguments from the command line
        const { values, positionals } = parseArgs({ options: cliOptions, allowPositionals: true });

        // Configure logger from CLI args
        configureLogger(values);

        if ((values as any).help) {
            printHelpMessage();
            return;
        }
        // Remote management mode
        const parseResult = await parseRemoteManagement(values);
        if (parseResult && parseResult.Error) {
            logger.error("Failed to initiate remote management:", parseResult.Error);
            process.exit(1);
        }

        let finalConfig;
        // Build final configuration from parsed args
        try {
            logger.debug("Building final config from CLI values and positionals", { values, positionals });
            finalConfig = buildFinalConfig(values as Record<string, unknown>, positionals as string[]);
        } catch (error) {
            logger.error("Failed to build final configuration:", error);
            console.error(`Error : ${error}`);
            process.exit(1);
        }
        logger.debug("Final configuration built", finalConfig);
        logger.info(`Forwarding to: ${finalConfig.forwardTo}`);

        // Use the TunnelManager to start the tunnel
        const manager = TunnelManager.getInstance();
        const tunnel = manager.createTunnel(finalConfig);

        logger.info("Connecting to Pinggy...", { configId: finalConfig.configid });
        logger.info("Connecting to Pinggy...");

        // const urls = await manager.startTunnel(tunnel.tunnelId);

        logger.info("Tunnel status after create:", tunnel.instance.getStatus());
        console.log("Remote URLs:");
        // urls.forEach(url => console.log(`  => ${url}`));

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
