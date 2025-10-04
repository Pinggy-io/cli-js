import CLIPrinter from "../utils/printer.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import chalk from "chalk";
import { FinalConfig } from "../types.js";
import TunnelTui from "../tui/index.js";
import { withFullScreen } from "fullscreen-ink";


declare global {
    var __PINGGY_TUNNEL_STATS__: ((stats: any) => void) | undefined;
}

export async function startCli(finalConfig: FinalConfig, manager: TunnelManager, NoTUI: boolean = false) {
    try {
        let tunnelListenerId;
        CLIPrinter.startSpinner("Connecting to Pinggy...");

        const tunnel = manager.createTunnel(finalConfig);

        if (!NoTUI) {
            tunnelListenerId = manager.registerStatsListener(tunnel.tunnelid, (tunnelId, stats) => {
                // Emit stats to TUI via global callback
                globalThis.__PINGGY_TUNNEL_STATS__?.(stats);
            });
        }

        await manager.startTunnel(tunnel.tunnelid);


        CLIPrinter.stopSpinnerSuccess("Connected to Pinggy");

        const urls = manager.getTunnelUrls(tunnel.tunnelid);
        const greet = manager.getTunnelGreetMessage(tunnel.tunnelid);

        CLIPrinter.success(chalk.bold("Tunnel established!"));
        CLIPrinter.print(chalk.gray("───────────────────────────────"));

        CLIPrinter.info(chalk.cyanBright("Remote URLs:"));
        urls.forEach((url: string) =>
            CLIPrinter.print("  " + chalk.magentaBright(url))
        );

        CLIPrinter.print(chalk.gray("───────────────────────────────"));

        // handle greet messages
        if (greet?.includes("not authenticated")) {
            // show unauthenticated warning
            CLIPrinter.warn(chalk.yellowBright(greet));
        } else if (greet?.includes("authenticated as")) {
            // extract email
            const emailMatch = /authenticated as (.+)/.exec(greet);
            const email = emailMatch ? emailMatch[1] : greet;
            CLIPrinter.info("Authenticated as: " + chalk.greenBright(email));
        }

        if (!NoTUI) {
           
            const tui = withFullScreen(
                <TunnelTui
                    urls={urls}
                    greet={greet || ""}
                    tunnel={tunnel}
                    manager={manager}
                    listenerId={tunnelListenerId}
                />

            );
            await tui.start();

        
        } else {
            CLIPrinter.print(chalk.gray("\nPress Ctrl+C to stop the tunnel.\n"));
        }
    } catch (err: any) {
        CLIPrinter.stopSpinnerFail("Failed to connect");
        CLIPrinter.error(err.message || "Unknown error");
        throw err;
    }
}
