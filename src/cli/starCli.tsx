import CLIPrinter from "../utils/printer.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import chalk from "chalk";
import { FinalConfig } from "../types.js";
import TunnelTui from "../tui/index.js";
import { withFullScreen } from "fullscreen-ink";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { getFreePort } from "../utils/getFreePort.js";
import { fileURLToPath } from "url";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


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
    const workerPath = path.resolve(__dirname, "../workers/worker.js");
    try {
        const worker = new Worker(workerPath, {
            workerData: { finalConfig },
        });
        worker.on("message", async (msg) => {
            switch (msg.type) {
                case "created":
                    CLIPrinter.startSpinner(msg.message);
                    break;

                case "started":
                    CLIPrinter.stopSpinnerSuccess(msg.message);
                    CLIPrinter.success(chalk.bold("Tunnel established!"));
                    CLIPrinter.print(chalk.gray("───────────────────────────────"));

                    break;

                case "urls":
                    TunnelData.urls = msg.urls;
                    CLIPrinter.info(chalk.cyanBright("Remote URLs:"));
                    (TunnelData.urls ?? []).forEach((url: string) =>
                        CLIPrinter.print("  " + chalk.magentaBright(url))
                    );
                    CLIPrinter.print(chalk.gray("───────────────────────────────"));
                    CLIPrinter.print(chalk.gray("\nPress Ctrl+C to stop the tunnel.\n"));

                    break;

                case "greetmsg":
                    TunnelData.greet = msg.message;
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
                    break;

                case "status":
                    CLIPrinter.info(msg.message || "Status update from worker");
                    break;

                case "usage":
                    TunnelData.usage = msg.usage;
                    globalThis.__PINGGY_TUNNEL_STATS__?.(msg.usage);
                    break;

                case "TUI":
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
                    break;

                case "warnings":
                    CLIPrinter.warn(msg.message);
                    break;

                case "disconnected":
                    if (activeTui && updateDisconnectState) {
                        disconnectState = {
                            disconnected: true,
                            error: msg.error,
                            messages: msg.messages
                        };
                        updateDisconnectState(disconnectState);

                        try {
                            // Wait for Ink to fully exit
                            await activeTui.waitUntilExit();
                        } catch (e) {
                            logger.warn("Failed to wait for TUI exit", e);
                        } finally {
                            activeTui = null;
                        }
                    }

                    if (msg.messages?.length) {
                        msg.messages.forEach((m: string) => CLIPrinter.print(m));
                    }

                    // Exit ONLY after fullscreen ink has restored the terminal
                    process.exit(0);
                    break;


                case "error":
                    CLIPrinter.error(msg.message || "Unknown error from worker");
                    break;
            }
        });

        worker.on("error", (err) => {
            logger.error("Worker thread error:", err);
            CLIPrinter.error(`${err}`);
        });

        worker.on("exit", (code) => {
            if (code !== 0) {
                CLIPrinter.error(`Worker stopped with exit code ${code}`);
            } else {
                console.log("Worker exited cleanly.");
            }
        });

    } catch (err: any) {
        CLIPrinter.stopSpinnerFail("Failed to connect");
        CLIPrinter.error(err.message || "Unknown error");
        throw err;
    }
}
