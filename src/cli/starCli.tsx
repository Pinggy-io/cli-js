import CLIPrinter from "../utils/printer.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import chalk from "chalk";
import { FinalConfig } from "../types.js";
import TunnelTui from "../tui/index.js";
import { withFullScreen } from "fullscreen-ink";
import { getFreePort } from "../utils/getFreePort.js";
import { logger } from "../logger.js";
import React, { useState } from "react";

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

const TunnelTuiWrapper = ({ finalConfig, urls, greet }: any) => {
    const [disconnectInfo, setDisconnectInfo] = useState<typeof disconnectState>(null);


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

export async function startCli(finalConfig: FinalConfig, manager: TunnelManager) {
    if (!finalConfig.NoTUI && finalConfig.webDebugger === "") {
        // Need a webdebugger port 
        const freePort = await getFreePort(finalConfig.webDebugger || "");
        finalConfig.webDebugger = `localhost:${freePort}`;
    }

    try {
        const manager = TunnelManager.getInstance();
        const tunnel = manager.createTunnel(finalConfig);
        CLIPrinter.startSpinner("Connecting to Pinggy...");
        if (!finalConfig.NoTUI) {
            manager.registerStatsListener(tunnel.tunnelid, (tunnelId, stats) => {
                globalThis.__PINGGY_TUNNEL_STATS__?.(stats)
            })
        }

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

        if (!finalConfig.NoTUI) {
            const tui = withFullScreen(
                <TunnelTuiWrapper
                    finalConfig={finalConfig}
                    urls={TunnelData.urls}
                    greet={TunnelData.greet}
                />
            );

            activeTui = tui;

            try {
                await tui.start();
                await tui.waitUntilExit();
            } catch (e) {
                logger.warn("TUI error", e);
            } finally {
                activeTui = null;
            }
        }

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
                    // Exit ONLY after fullscreen ink has restored the terminal
                    process.exit(0);
                }
            } else {
                messages.forEach(function (m) {
                    CLIPrinter.warn(m)
                });
                process.exit(0);
            }
        })

    } catch (err: any) {
        CLIPrinter.stopSpinnerFail("Failed to connect");
        CLIPrinter.error(err.message || "Unknown error");
        throw err;
    }
}
