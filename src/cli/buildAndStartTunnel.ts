import { logger } from "../logger.js";
import {
    buildRemoteManagementWsUrl,
    initiateRemoteManagement,
    startRemoteManagement,
} from "../remote_management/remoteManagement.js";
import { ParsedValues } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { buildFinalConfig, parseUsers } from "./buildConfig.js";
import CLIPrinter from "../utils/printer.js";
import {
    saveConfig,
    validateName,
} from "./configStore.js";
import { TunnelClient } from "../daemon/tunnelClient.js";
import { startForegroundViaDaemon, startBackgroundViaDaemon } from "./startCli.js";

type CliValues = ParsedValues<typeof cliOptions>;

type Intent =
    | { kind: "tunnel" }
    | { kind: "remote-only" }
    | { kind: "invalid"; message: string };

function analyzeIntent(values: CliValues, positionals: string[]): Intent {
    const hasTunnelFlag = !!(
        (Array.isArray(values.R) && values.R.length > 0) ||
        (Array.isArray(values.L) && values.L.length > 0) ||
        values.localport ||
        values.type ||
        values.conf ||
        values.serve
    );

    const parsed = parseUsers(positionals, values.token);
    const hasServerFromArgs = !!parsed.server;

    if (hasTunnelFlag || hasServerFromArgs) return { kind: "tunnel" };

    if (positionals.length > 0) {
        return {
            kind: "invalid",
            message:
                `Unrecognized argument(s): ${positionals.join(" ")}\n` +
                `Usage: pinggy -l 3000  \n` +
                `Try:   pinggy --help`,
        };
    }

    const rmToken = values["remote-management"];
    if (typeof rmToken === "string" && rmToken.trim().length > 0) {
        return { kind: "remote-only" };
    }

    return {
        kind: "invalid",
        message:
            "No tunnel specified.\n" +
            "Usage: pinggy -l 3000   or   pinggy <token>@<server>\n" +
            "Try:   pinggy --help",
    };
}

/**
 * Build config from CLI args, optionally save it, and start the tunnel.
 */
export async function buildAndStartTunnel(
    values: CliValues,
    positionals: string[],
): Promise<void> {
    const intent = analyzeIntent(values, positionals);

    if (intent.kind === "invalid") {
        CLIPrinter.error(intent.message);
        process.exit(1);
    }

    if (intent.kind === "remote-only") {
        CLIPrinter.print("Remote management mode. Press Ctrl+C to stop.");
        await initRemoteManagement(values, /* blocking */ true);
        return;
    }

    // Tunnel intent. Start remote management in the background (if requested),
    // then proceed to build and start the tunnel.
    await initRemoteManagement(values, /* blocking */ false);

    logger.debug("Building final config from CLI values and positionals", { values, positionals });
    const finalConfig = await buildFinalConfig(values, positionals);
    logger.debug("Final configuration built", finalConfig);

    if (values.save) {
        const name = values.name;
        if (!name) {
            CLIPrinter.error("--save requires --name to specify a name for the tunnel config.");
            process.exit(1);
        }
        const nameErr = validateName(name);
        if (nameErr) {
            CLIPrinter.error(nameErr.message);
            process.exit(1);
        }
        const autoStart = !!values.auto;
        saveConfig(name, finalConfig.configId!, finalConfig, autoStart);
        CLIPrinter.success(`Config "${name}" saved.`);
    }

    if (values.b) {
        await startBackgroundViaDaemon(finalConfig);
        return;
    }

    await startForegroundViaDaemon(finalConfig);
}

async function initRemoteManagement(values: CliValues, blocking: boolean): Promise<void> {
    const rmToken = values["remote-management"];
    if (typeof rmToken !== "string" || rmToken.trim().length === 0) return;

    // Ensure daemon is running so remote management can route tunnel ops through it
    const handler = await TunnelClient.forRemoteManagement();

    const config = {
        apiKey: rmToken,
        serverUrl: buildRemoteManagementWsUrl(values["manage"]),
    };

    try {
        if (blocking) {
            // Remote-only mode: stay attached until SIGINT.
            await initiateRemoteManagement(config, handler);
        } else {
            // Returns after first connection; reconnect loop runs in the background.
            await startRemoteManagement(config, handler);
        }
    } catch (e) {
        logger.error("Failed to initiate remote management:", e);
        CLIPrinter.fatal(e);
    }
}
