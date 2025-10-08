import CLIPrinter from "../utils/printer.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import chalk from "chalk";
import { FinalConfig } from "../types.js";
import TunnelTui from "../tui/index.js";
import { withFullScreen } from "fullscreen-ink";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { getFreePort } from "../utils/getFreePort.js";

const TunnelData: {
    urls: string[] | null;
    greet: string | null;
    usage: any;
} = {
    urls: null,
    greet: null,
    usage: null,
};

declare global {
    var __PINGGY_TUNNEL_STATS__: ((stats: any) => void) | undefined;
}

export async function startCli(finalConfig: FinalConfig, manager: TunnelManager) {
    if (!finalConfig.NoTUI && finalConfig.webDebugger === "") {
        // Need a webdebugger port 
        const freePort = await getFreePort(finalConfig.webDebugger || "");
        finalConfig.webDebugger = `localhost:${freePort}`;
    }
    const workerPath = path.resolve("./dist/cli/worker.js");
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
                    console.log("Usage update:", msg.usage);
                    TunnelData.usage = msg.usage;
                    globalThis.__PINGGY_TUNNEL_STATS__?.(msg.usage);
                    break;
                case "TUI":
                    if (!finalConfig.NoTUI) {
                        const tui = withFullScreen(
                            <TunnelTui
                                urls={TunnelData.urls ?? []}
                                greet={TunnelData.greet ?? ""}
                                tunnelConfig={finalConfig}
                            />
                        );
                        await tui.start();
                    }
                    break;

                case "error":
                    CLIPrinter.error(msg.message || "Unknown error from worker");
                    break;
            }
        });

        worker.on("error", (err) => {
            CLIPrinter.error(`Worker thread error: ${err}`);
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
