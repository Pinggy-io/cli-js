#!/usr/bin/env node
import { parseArgs } from "util";
import { TunnelManager } from "./TunnelManager";
import { printHelpMessage } from "./cli/help";
import { cliOptions } from "./cli/options";
import { buildFinalConfig } from "./cli/buildConfig";


async function main() {
    try {
        // Parse arguments from the command line
        const { values, positionals } = parseArgs({ options: cliOptions, allowPositionals: true });

        if (values.help) {
            printHelpMessage();
            return;
        }

        // Build final configuration from parsed args
        const finalConfig = buildFinalConfig(values as Record<string, unknown>, positionals as string[]);

        console.log("Final configuration:", finalConfig);

        console.log(`Forwarding to: ${finalConfig.forwardTo}`);

        // Use the TunnelManager to start the tunnel
        const manager = new TunnelManager();
        const tunnel = manager.createTunnel(finalConfig);

        console.log("Connecting to Pinggy...");

        const urls = await manager.startTunnel(tunnel.tunnelId);

        console.log("\nTunnel is ", tunnel.instance.getStatus());
        console.log("Remote URLs:");
        urls.forEach(url => console.log(`  => ${url}`));

        console.log("\nPress Ctrl+C to stop the tunnel.");

        // Keep the process alive and handle graceful shutdown
        process.on('SIGINT', () => {
            console.log("\nStopping all tunnels...");
            manager.stopAllTunnels();
            console.log("Tunnels stopped. Exiting.");
            process.exit(0);
        });

    } catch (error) {
        console.error(`An error occurred: ${error}`);
        process.exit(1);
    }
}


main();
