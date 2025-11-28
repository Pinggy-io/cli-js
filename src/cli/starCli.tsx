import CLIPrinter from "../utils/printer.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { loadChalk } from "../utils/esmOnlyPackageLoader.js";
import { FinalConfig } from "../types.js";
import { getFreePort } from "../utils/getFreePort.js";
import { logger } from "../logger.js";

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

let activeTui: {
    instance?: { unmount?: () => void };
    start: () => Promise<void>;
    waitUntilExit: () => Promise<void>;
} | null = null;


let disconnectState: {
    disconnected: boolean;
    error?: string;
    messages?: string[];
} | null = null;

let updateDisconnectState: ((state: typeof disconnectState) => void) | null = null;

declare global {
    var __PINGGY_TUNNEL_STATS__: ((stats: any) => void) | undefined;
}



export async function startCli(finalConfig: FinalConfig, manager: TunnelManager) {

    await CLIPrinter.ensureDeps();
    const chalk = await loadChalk();

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
        CLIPrinter.stopSpinnerSuccess("Connected to Pinggy");
        CLIPrinter.success(chalk.bold("Tunnel established!"));
        CLIPrinter.print(chalk.gray("───────────────────────────────"));

        TunnelData.urls = await manager.getTunnelUrls(tunnel.tunnelid);
        TunnelData.greet = await manager.getTunnelGreetMessage(tunnel.tunnelid);

        CLIPrinter.info(chalk.cyanBright("Remote URLs:"));
        (TunnelData.urls ?? []).forEach((url: string) =>
            CLIPrinter.print("  " + chalk.magentaBright(url))
        );
        CLIPrinter.print(chalk.gray("───────────────────────────────"));


        if (TunnelData.greet?.includes("not authenticated")) {
            // show unauthenticated warning
            CLIPrinter.warn(chalk.yellowBright(TunnelData.greet));
        } else if (TunnelData.greet?.includes("authenticated as")) {
            // extract email
            const emailMatch = /authenticated as (.+)/.exec(TunnelData.greet);
            if (emailMatch) {
                const email = emailMatch[1];
                CLIPrinter.info(chalk.cyanBright("Authenticated as: " + email));
            }
        }

        CLIPrinter.print(chalk.gray("───────────────────────────────"));
        CLIPrinter.print(chalk.gray("\nPress Ctrl+C to stop the tunnel.\n"));

        manager.registerDisconnectListener(tunnel.tunnelid, async (tunnelId, error, messages) => {
            if (activeTui && updateDisconnectState) {
                disconnectState = {
                    disconnected: true,
                    error: error,
                    messages: messages
                };
                updateDisconnectState(disconnectState);

                try {
                    // Wait for Ink to fully exit
                    await activeTui.waitUntilExit();
                } catch (e) {
                    logger.warn("Failed to wait for TUI exit", e);
                } finally {
                    activeTui = null;
                    messages?.forEach(function (m) {
                        CLIPrinter.warn(m)
                    });

                    if (error) {
                        CLIPrinter.warn(`Error in tunnel: ${error}`);
                    }
                    // Exit ONLY after fullscreen ink has restored the terminal

                    if (!finalConfig.autoReconnect) {
                        process.exit(0);
                    }
                }
            } else {
                messages?.forEach(function (m) {
                    CLIPrinter.warn(m)
                });

                if (error) {
                    CLIPrinter.warn(`Error in tunnel: ${error}`);
                }

                if (!finalConfig.autoReconnect) {
                    process.exit(0);
                }
            }
        })

        // Shared helper to create and start the fullscreen TUI
        const launchTui = async (finalConfig: FinalConfig, urls: string[] | null, greet: string | null) => {
            try {
                const { withFullScreen } = await import("fullscreen-ink");
                const { default: TunnelTui } = await import("../tui/index.js");
                const React = await import("react");
                const isTTYEnabled = process.stdin.isTTY;

                const TunnelTuiWrapper = ({ finalConfig, urls, greet }: any) => {
                    const [disconnectInfo, setDisconnectInfo] = React.useState<typeof disconnectState>(null);

                    React.useEffect(() => {
                        updateDisconnectState = setDisconnectInfo;
                        return () => {
                            updateDisconnectState = null;
                        };
                    }, []);

                    return (
                        <TunnelTui
                            urls={urls ?? []}
                            greet={greet ?? ""}
                            tunnelConfig={finalConfig}
                            disconnectInfo={disconnectInfo}
                        />
                    );
                };

                const tui = withFullScreen(
                    <TunnelTuiWrapper
                        finalConfig={finalConfig}
                        urls={urls}
                        greet={greet}
                    />
                );

                activeTui = tui;

                if (isTTYEnabled) {
                    try {
                        await tui.start();
                        await tui.waitUntilExit();
                    } catch (e) {
                        logger.warn("TUI error", e);
                    } finally {
                        activeTui = null;
                    }
                } else {
                    CLIPrinter.warn("Unable to initiate the TUI: your terminal does not support the required input mode.");
                }
            } catch (e) {
                logger.warn("Failed to (re-)initiate TUI", e);
            }
        };

        // Listen for tunnel start events (auto-reconnect)
        try {
            await manager.registerStartListener(tunnel.tunnelid, async (tunnelId, urls) => {
                try {
                    CLIPrinter.stopSpinnerSuccess("Reconnected to Pinggy");
                } catch (e) {
                    // ignore
                }

                CLIPrinter.success(chalk.bold("Tunnel re-established!"));
                CLIPrinter.print(chalk.gray("───────────────────────────────"));

                TunnelData.urls = urls;
                TunnelData.greet = await manager.getTunnelGreetMessage(tunnel.tunnelid);

                CLIPrinter.info(chalk.cyanBright("Remote URLs:"));
                (TunnelData.urls ?? []).forEach((url: string) =>
                    CLIPrinter.print("  " + chalk.magentaBright(url))
                );
                CLIPrinter.print(chalk.gray("───────────────────────────────"));

                if (TunnelData.greet?.includes("not authenticated")) {
                    CLIPrinter.warn(chalk.yellowBright(TunnelData.greet));
                } else if (TunnelData.greet?.includes("authenticated as")) {
                    const emailMatch = /authenticated as (.+)/.exec(TunnelData.greet);
                    if (emailMatch) {
                        const email = emailMatch[1];
                        CLIPrinter.info(chalk.cyanBright("Authenticated as: " + email));
                    }
                }

                CLIPrinter.print(chalk.gray("───────────────────────────────"));
                CLIPrinter.print(chalk.gray("\nPress Ctrl+C to stop the tunnel.\n"));

                // If the TUI was enabled previously, re-create and start it
                if (!finalConfig.NoTUI) {
                    await launchTui(finalConfig, TunnelData.urls, TunnelData.greet);
                }
            });
        } catch (e) {
            logger.debug("Failed to register start listener", e);
        }

        if (!finalConfig.NoTUI) {
            await launchTui(finalConfig, TunnelData.urls, TunnelData.greet);
        }



    } catch (err: any) {
        CLIPrinter.stopSpinnerFail("Failed to connect");
        CLIPrinter.error(err.message || "Unknown error");
        throw err;
    }
}
