/**
 * `pinggy attach <name|id>` — Re-attach TUI to a running daemon tunnel.
 */

import pico from "picocolors";
import CLIPrinter from "../../../utils/printer.js";
import { TunnelClient } from "../../../daemon/tunnelClient.js";
import { isErrorResponse } from "../../../types.js";
import { connectTui, findTunnel } from "../../startCli.js";
import { TunnelConfigV1 } from "../../../remote_management/remote_schema.js";
import { errorMessage } from "../../../utils/util.js";


export async function handleAttach(args: string[]): Promise<void> {
    if (args.length === 0) {
        CLIPrinter.error("Usage: pinggy attach <name|id>");
        return;
    }

    const nameOrId = args[0];
    const client = new TunnelClient();

    try {
        await client.ensureDaemon();
    } catch (err) {
        CLIPrinter.error(`Cannot connect to daemon: ${errorMessage(err)}`);
        return;
    }

    try {
        const tunnels = await client.handleListV2();

        if (isErrorResponse(tunnels)) {
            CLIPrinter.error(`Failed to list tunnels: ${tunnels.message}`);
            return;
        }

        const match = findTunnel(tunnels, nameOrId);
        if (!match) {
            CLIPrinter.error(`No running tunnel found matching "${nameOrId}". Use: pinggy ps`);
            client.close();
            return;
        }

        const tunnelId = match.tunnelid;
        const name = (match.tunnelconfig as TunnelConfigV1)?.name  || tunnelId.slice(0, 12);

        CLIPrinter.print(pico.cyanBright(`Attaching to tunnel "${name}"...`));

        // Preserve the tunnel's existing lifecycle mode so attach is a pure
        // viewing operation.
        const attachMode = match.mode ?? "detached";
        await client.attach(tunnelId, attachMode);

        const urls: string[] = match.remoteurls || [];
        if (urls.length > 0) {
            CLIPrinter.print("");
            for (const url of urls) {
                CLIPrinter.print("  " + pico.magentaBright(url));
            }
            CLIPrinter.print("");
        }

        await connectTui({
            client,
            tunnelId,
            urls,
            greet: match.greetmsg || "",
            tunnelConfig: match.tunnelconfig || {},
            exitMessage: "Detaching...",
            onExit: () => Promise.resolve(client.detach(tunnelId)),
        });
    } catch (err) {
        CLIPrinter.error(`Failed to attach: ${errorMessage(err)}`);
    } finally {
        client.close();
    }
}

