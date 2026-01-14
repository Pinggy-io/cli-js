import CLIPrinter from "../utils/printer.js";
import { ManagedTunnel, TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { FinalConfig } from "../types.js";
import { getFreePort } from "../utils/getFreePort.js";
import { logger } from "../logger.js";
import pico from "picocolors";
import { TunnelTui } from "../tui/blessed/index.js"

interface TunnelData {
    urls: string[] | null;
    greet: string | null;
    usage: any;
}

const TunnelData: TunnelData = {
    urls: null,
    greet: null,
    usage: null,
};

let activeTui: any = null; // TunnelTui type - loaded dynamically

let disconnectState: {
    disconnected: boolean;
    error?: string;
    messages?: string[];
} | null = null;

declare global {
    var __PINGGY_TUNNEL_STATS__: ((stats: any) => void) | undefined;
}

async function launchTui(finalConfig: FinalConfig, urls: string[] | null, greet: string | null, tunnel: ManagedTunnel) {
    try {
        const isTTYEnabled = process.stdin.isTTY;

        if (!isTTYEnabled) {
            CLIPrinter.warn("Unable to initiate the TUI: your terminal does not support the required input mode.");
            return;
        }


        const tui = new TunnelTui({
            urls: urls ?? [],
            greet: greet ?? "",
            tunnelConfig: finalConfig,
            disconnectInfo: null,
            tunnelInstance: tunnel,
        });

        activeTui = tui;

        try {
            tui.start();
            await tui.waitUntilExit();
        } catch (e) {
            logger.warn("TUI error", e);
        } finally {
            activeTui = null;
        }
    } catch (e) {
        logger.warn("Failed to (re-)initiate TUI", e);
    }
}



export async function startCli(finalConfig: FinalConfig, manager: TunnelManager) {


    if (!finalConfig.NoTUI && finalConfig.webDebugger === "") {
        // Need a webdebugger port 
        const freePort = await getFreePort(finalConfig.webDebugger || "");
        finalConfig.webDebugger = `localhost:${freePort}`;
    }

    try {
        const manager = TunnelManager.getInstance();
        const tunnel = await manager.createTunnel(finalConfig);


        CLIPrinter.startSpinner("Connecting to Pinggy...");


        if (!finalConfig.NoTUI) {
            manager.registerStatsListener(tunnel.tunnelid, (tunnelId, stats) => {
                globalThis.__PINGGY_TUNNEL_STATS__?.(stats)
            })
        }


        manager.registerWorkerErrorListner(tunnel.tunnelid, (_tunnelid: string, error: Error) => {

            // The CLI terminates in this callback because these errors occur only when the tunnel worker
            // exits, crashes, or encounters critical problems (e.g., authentication failure or primary forwarding failure).

            CLIPrinter.error(`${error.message}`);
        });


        await manager.startTunnel(tunnel.tunnelid);
        CLIPrinter.stopSpinnerSuccess(" Connected to Pinggy");
        CLIPrinter.success(pico.bold("Tunnel established!"));
        CLIPrinter.print(pico.gray("───────────────────────────────"));

        TunnelData.urls = await manager.getTunnelUrls(tunnel.tunnelid);
        TunnelData.greet = await manager.getTunnelGreetMessage(tunnel.tunnelid);

        CLIPrinter.info(pico.cyanBright("Remote URLs:"));
        (TunnelData.urls ?? []).forEach((url: string) =>
            CLIPrinter.print("  " + pico.magentaBright(url))
        );
        CLIPrinter.print(pico.gray("───────────────────────────────"));


        if (TunnelData.greet?.includes("not authenticated")) {
            // show unauthenticated warning
            CLIPrinter.warn(pico.yellowBright(TunnelData.greet));
        } else if (TunnelData.greet?.includes("authenticated as")) {
            // extract email
            const emailMatch = /authenticated as (.+)/.exec(TunnelData.greet);
            if (emailMatch) {
                const email = emailMatch[1];
                CLIPrinter.info(pico.cyanBright("Authenticated as: " + email));
            }
        }

        CLIPrinter.print(pico.gray("───────────────────────────────"));
        CLIPrinter.print(pico.gray("\nPress Ctrl+C to stop the tunnel.\n"));

        manager.registerDisconnectListener(tunnel.tunnelid, async (tunnelId, error, messages) => {
            if (activeTui) {
                disconnectState = {
                    disconnected: true,
                    error: error,
                    messages: messages
                };
                activeTui.updateDisconnectInfo(disconnectState);

                try {
                    // Wait for Blessed TUI to fully exit
                    await activeTui.waitUntilExit();
                } catch (e) {
                    logger.warn("Failed to wait for TUI exit", e);
                } finally {
                    activeTui = null;
                    CLIPrinter.warn(`Error in tunnel:`);
                    messages?.forEach(function (m) {
                        CLIPrinter.warnTxt(m)
                    });

                    // Exit ONLY after blessed has restored the terminal
                    // On disconnect only exit if autoReconnect is false otherwise retry will not work
                    if (!finalConfig.autoReconnect) {
                        process.exit(0);
                    }
                }
            } else {
                messages?.forEach(function (m) {
                    CLIPrinter.warn(m)
                });

                // On disconnect only exit if autoReconnect is false otherwise retry will not work
                if (!finalConfig.autoReconnect) {
                    process.exit(0);
                }
            }

            // start a spinner if autoReconnect is true
            if (finalConfig.autoReconnect) {
                CLIPrinter.startSpinner("Reconnecting to Pinggy");
            }
        })

        // Listen for tunnel start events (auto-reconnect)
        try {
            await manager.registerStartListener(tunnel.tunnelid, async (tunnelId, urls) => {
                try {
                    CLIPrinter.stopSpinnerSuccess("Reconnected to Pinggy");
                } catch (e) {
                    // ignore
                }

                CLIPrinter.success(pico.bold("Tunnel re-established!"));
                CLIPrinter.print(pico.gray("───────────────────────────────"));

                TunnelData.urls = urls;
                TunnelData.greet = await manager.getTunnelGreetMessage(tunnel.tunnelid);

                CLIPrinter.info(pico.cyanBright("Remote URLs:"));
                (TunnelData.urls ?? []).forEach((url: string) =>
                    CLIPrinter.print("  " + pico.magentaBright(url))
                );
                CLIPrinter.print(pico.gray("───────────────────────────────"));

                if (TunnelData.greet?.includes("not authenticated")) {
                    CLIPrinter.warn(pico.yellowBright(TunnelData.greet));
                } else if (TunnelData.greet?.includes("authenticated as")) {
                    const emailMatch = /authenticated as (.+)/.exec(TunnelData.greet);
                    if (emailMatch) {
                        const email = emailMatch[1];
                        CLIPrinter.info(pico.cyanBright("Authenticated as: " + email));
                    }
                }

                CLIPrinter.print(pico.gray("───────────────────────────────"));
                CLIPrinter.print(pico.gray("\nPress Ctrl+C to stop the tunnel.\n"));

                // If the TUI was enabled previously, re-create and start it
                if (!finalConfig.NoTUI) {
                    await launchTui(finalConfig, TunnelData.urls, TunnelData.greet, tunnel);
                }
            });
        } catch (e) {
            logger.debug("Failed to register start listener", e);
        }

        if (!finalConfig.NoTUI) {
            await launchTui(finalConfig, TunnelData.urls, TunnelData.greet,tunnel);
        }



    } catch (err: any) {
        CLIPrinter.stopSpinnerFail("Failed to connect");
        CLIPrinter.error(err.message || "Unknown error");
        throw err;
    }
}
