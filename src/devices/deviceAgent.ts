import WebSocket from "ws";
import os from "os";
import { logger } from "../logger.js";
import CLIPrinter from "../utils/printer.js";
import { getVersion } from "../utils/util.js";
import {
    CHANNEL_SYSTEM, Envelope, OP_DISCONNECT, OP_HEARTBEAT, OP_HELLO, OP_WELCOME,
    event, parseEnvelope, request,
} from "./envelope.js";
import { DisconnectSchema, ErrorPayloadSchema, Hello, WelcomeSchema } from "./device_schema.js";
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from "./deviceIdentity.js";

/**
 * Slice 01 keeps the fixed retry that remote management uses. Exponential backoff with jitter and a
 * pong watchdog arrive in slice 04; this file is the only thing that changes then.
 */
const RECONNECT_SLEEP_MS = 5000;

/** The dashboard closes with this after sending system/disconnect. Terminal: never retry. */
const CLOSE_CODE_REVOKED = 4001;

const TOKEN_HEADER = "X-Pinggy-Device-Token";

const CAPABILITIES = ["tunnel", "stats"];

let stopRequested = false;

export function buildDeviceAgentWsUrl(manage?: string): string {
    let baseUrl = (manage || "dashboard.pinggy.io").trim();
    if (!(baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://"))) {
        baseUrl = "wss://" + baseUrl;
    }
    return `${baseUrl.replace(/\/$/, "")}/backend/api/v1/device-agent/ws/connect`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHello(): Hello {
    return {
        agent_version: getVersion(),
        os: os.platform(),
        hostname: os.hostname(),
        capabilities: CAPABILITIES,
    };
}

/**
 * Runs the device agent until interrupted, or until the dashboard tells us the credential is gone.
 */
export async function runDeviceAgent(token: string, manage?: string): Promise<void> {
    const wsUrl = buildDeviceAgentWsUrl(manage);
    const server = manage || "dashboard.pinggy.io";

    let identity: DeviceIdentity = readDeviceIdentity() ?? {
        device_agent_id: null, token, server, enrolled_at: null,
    };
    // A token passed on the command line always wins over what is on disk.
    identity = { ...identity, token, server };

    stopRequested = false;
    const sigintHandler = () => { stopRequested = true; };
    process.once("SIGINT", sigintHandler);

    while (!stopRequested) {
        CLIPrinter.print(`Connecting to ${server}`);
        const outcome = await connectOnce(wsUrl, identity);

        if (outcome === "terminal" || stopRequested) {
            break;
        }
        CLIPrinter.warn(`Disconnected. Reconnecting in ${RECONNECT_SLEEP_MS / 1000} seconds...`);
        await sleep(RECONNECT_SLEEP_MS);
    }

    process.removeListener("SIGINT", sigintHandler);
}

type Outcome = "retry" | "terminal";

function connectOnce(wsUrl: string, identity: DeviceIdentity): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { [TOKEN_HEADER]: identity.token } });

        let heartbeat: NodeJS.Timeout | null = null;
        let settled = false;

        const finish = (outcome: Outcome) => {
            if (settled) return;
            settled = true;
            if (heartbeat) clearInterval(heartbeat);
            resolve(outcome);
        };

        ws.once("open", () => {
            logger.info("Device agent socket open, sending hello");
            ws.send(JSON.stringify(request(CHANNEL_SYSTEM, OP_HELLO, buildHello())));
        });

        ws.on("ping", () => ws.pong());

        ws.on("message", (data) => {
            const envelope = parseEnvelope(data.toString("utf8"));
            if (!envelope) {
                logger.debug("Ignoring unparseable frame");
                return;
            }
            const outcome = handleFrame(ws, envelope, identity, (interval) => {
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(
                            event(CHANNEL_SYSTEM, OP_HEARTBEAT, { uptime_seconds: Math.floor(os.uptime()) })));
                    }
                }, interval * 1000);
            });
            if (outcome === "terminal") {
                finish("terminal");
                ws.close();
            }
        });

        ws.on("unexpected-response", (_req, res) => {
            if (res.statusCode === 401) {
                CLIPrinter.error("Unauthorized. This device token is not valid. Re-enrol the device "
                    + "from the dashboard and run the install command again.");
                finish("terminal");
            } else {
                CLIPrinter.warn(`Unexpected HTTP ${res.statusCode}.`);
                finish("retry");
            }
            ws.close();
        });

        ws.on("close", (code, reason) => {
            logger.info("Device agent socket closed", { code, reason: reason.toString() });
            finish(code === CLOSE_CODE_REVOKED ? "terminal" : "retry");
        });

        ws.on("error", (err) => {
            logger.warn("Device agent socket error", { error: err.message });
            CLIPrinter.warn(err.message);
            finish("retry");
        });
    });
}

function handleFrame(ws: WebSocket, envelope: Envelope, identity: DeviceIdentity,
                     startHeartbeat: (intervalSeconds: number) => void): Outcome {
    if (envelope.ch !== CHANNEL_SYSTEM) {
        // Unknown channels are ignored, never fatal. That is what lets the dashboard add a channel
        // this build has never heard of.
        logger.debug("Ignoring frame on unknown channel", { channel: envelope.ch });
        return "retry";
    }

    if (envelope.op === OP_WELCOME) {
        const error = ErrorPayloadSchema.safeParse(envelope.payload);
        if (error.success) {
            CLIPrinter.error(`Handshake refused: ${error.data.error.message}`);
            return "terminal";
        }

        const welcome = WelcomeSchema.safeParse(envelope.payload);
        if (!welcome.success) {
            logger.warn("Welcome payload could not be read");
            return "retry";
        }

        identity.device_agent_id = welcome.data.device_agent_id;
        identity.enrolled_at = identity.enrolled_at ?? new Date().toISOString();
        writeDeviceIdentity(identity);

        CLIPrinter.success(`Connected as device ${welcome.data.device_agent_id}`);
        // Every cadence comes from welcome. Never fall back to a compiled-in default.
        startHeartbeat(welcome.data.heartbeat_interval_seconds);
        return "retry";
    }

    if (envelope.op === OP_DISCONNECT) {
        const disconnect = DisconnectSchema.safeParse(envelope.payload);
        const reason = disconnect.success ? disconnect.data.reason : "unknown";
        if (reason === "shutdown") {
            CLIPrinter.warn("Server is shutting down. Reconnecting.");
            return "retry";
        }
        CLIPrinter.error(`Disconnected by the dashboard: ${reason}. Re-enrol this device to continue.`);
        return "terminal";
    }

    logger.debug("Ignoring unhandled system op", { op: envelope.op });
    return "retry";
}
