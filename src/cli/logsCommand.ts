/**
 * `pinggy logs [name|id] [-f]` - Print or follow a tunnel or daemon log file.
 */
import fs from "node:fs";
import { TunnelClient } from "../daemon/tunnelClient.js";
import CLIPrinter from "../utils/printer.js";

export async function handleLogs(args: string[], follow: boolean): Promise<void> {
    const arg = args.find((a) => !a.startsWith("-"));

    const client = new TunnelClient();
    try {
        await client.ensureDaemon();
    } catch (err: any) {
        CLIPrinter.error(`Cannot connect to daemon: ${err.message}`);
        return;
    }

    let filePath: string;

    try {
        if (arg) {
            const result = await client.resolveLogPath(arg);
            if (result.status === "config-only") {
                CLIPrinter.error(`Tunnel "${arg}" is saved but has not been started yet. No logs available.`);
                client.close();
                process.exit(1);
            }
            if (result.status === "not-found") {
                CLIPrinter.error(`No tunnel or log file matching "${arg}".`);
                client.close();
                process.exit(1);
            }
            if (!result.path) {
                CLIPrinter.error(`No log path returned for "${arg}".`);
                client.close();
                process.exit(1);
            }
            filePath = result.path;
        } else {
            const paths = await client.getLogPaths();
            filePath = paths.daemon;
        }
    } catch (err: any) {
        CLIPrinter.error(`Failed to resolve log path: ${err.message}`);
        client.close();
        return;
    }

    client.close();

    if (!filePath || !fs.existsSync(filePath)) {
        CLIPrinter.error(`Log file not found: ${filePath}`);
        process.exit(1);
    }

    if (follow) {
        await followFile(filePath);
    } else {
        printTail(filePath, 100);
    }
}

function printTail(filePath: string, lines: number): void {
    const content = fs.readFileSync(filePath, "utf-8");
    const allLines = content.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    process.stdout.write(tail);
    if (!tail.endsWith("\n")) process.stdout.write("\n");
}

async function followFile(filePath: string): Promise<void> {
    if (fs.existsSync(filePath)) printTail(filePath, 20);

    let fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    let watcher: fs.FSWatcher | null = null;

    const openStream = () => {
        const stream = fs.createReadStream(filePath, { start: fileSize, encoding: "utf-8" });
        stream.on("data", (chunk) => {
            process.stdout.write(chunk as string);
            fileSize += Buffer.byteLength(chunk as string, "utf-8");
        });
        stream.on("error", () => {}); // file may rotate
    };

    watcher = fs.watch(filePath, { persistent: true }, (event) => {
        if (event === "change") {
            const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
            if (!stat || stat.size < fileSize) {
                // Rotation: reopen from start
                fileSize = 0;
            }
            openStream();
        }
    });

    await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
            watcher?.close();
            resolve();
        });
    });
}
