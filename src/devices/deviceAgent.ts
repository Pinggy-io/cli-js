import WebSocket from "ws";
import os from "os";
import { logger } from "../logger.js";
import CLIPrinter from "../utils/printer.js";
import { getVersion } from "../utils/util.js";
import {
    CHANNEL_DEVICE, CHANNEL_SYSTEM, Envelope, OP_DISCONNECT, OP_HEARTBEAT, OP_HELLO, OP_INFO, OP_METRICS,
    OP_WELCOME, event, parseEnvelope, request,
} from "./envelope.js";
import {
    DeviceMetrics, DisconnectSchema, ErrorPayloadSchema, Hello, Welcome, WelcomeSchema,
} from "./device_schema.js";
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from "./deviceIdentity.js";
import { collectSystemInfo } from "./collectors/systemInfo.js";
import { collectMetrics } from "./collectors/metrics.js";
import { ReconnectPolicy } from "./reconnect.js";

/** The dashboard closes with this after sending system/disconnect. Terminal: never retry. */
const CLOSE_CODE_REVOKED = 4001;

const TOKEN_HEADER = "X-Pinggy-Device-Token";

/** Retryable handshake refusal: a live node elsewhere still holds this device. */
const ERROR_ALREADY_CONNECTED = "already_connected";

/**
 * An upgrade that succeeds and is then never answered. Nothing else covers this window: the pong
 * watchdog cannot start until welcome names the interval, so without this the agent waits forever
 * on a dashboard that accepted the socket and stalled.
 */
const HANDSHAKE_TIMEOUT_MILLIS = 30_000;

/**
 * Missed pings before the socket is declared dead. 1 can be a slow network or a busy node; 2 in a
 * row is not.
 */
const PONG_GRACE_INTERVALS = 2;

const CAPABILITIES = ["tunnel", "stats"];

/**
 * Overrides for the 2 things a test cannot wait out: a 60 s backoff and a 30 s handshake timer.
 *
 * Production passes nothing. Injecting a policy also makes the delay itself assertable, which is
 * otherwise only visible as "the agent reconnected eventually".
 */
export interface DeviceAgentOptions {
    reconnectPolicy?: ReconnectPolicy;
    handshakeTimeoutMillis?: number;
}

let stopRequested = false;

/** Set while the loop is sleeping between attempts, so SIGINT does not wait out a 60 s backoff. */
let cancelPendingSleep: (() => void) | null = null;

export function buildDeviceAgentWsUrl(manage?: string): string {
    let baseUrl = (manage || "dashboard.pinggy.io").trim();
    if (!(baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://"))) {
        baseUrl = "wss://" + baseUrl;
    }
    return `${baseUrl.replace(/\/$/, "")}/backend/api/v1/device-agent/ws/connect`;
}

/** Resolves early if the agent is interrupted, so ctrl-C is not held up by the backoff. */
function sleep(millis: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            cancelPendingSleep = null;
            resolve();
        }, millis);

        cancelPendingSleep = () => {
            clearTimeout(timer);
            cancelPendingSleep = null;
            resolve();
        };
    });
}

function formatSeconds(millis: number): string {
    return (millis / 1000).toFixed(1);
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
 * Sends 1 reading at once, then 1 every `intervalSeconds`, until the returned function is called.
 *
 * The interval comes from `welcome` and nowhere else. The first reading goes out immediately so a
 * browser already watching does not wait a full interval after the agent connects.
 */
export function startMetricsReporting(intervalSeconds: number,
                                      collect: () => Promise<DeviceMetrics>,
                                      send: (metrics: DeviceMetrics) => void): () => void {
    let stopped = false;
    const report = () => {
        collect()
            .then((metrics) => {
                // A reading still sampling when the socket closed is dropped, not sent late.
                if (!stopped) send(metrics);
            })
            .catch((err) => logger.warn("Device metrics collection failed", { error: String(err) }));
    };

    report();
    const timer = setInterval(report, intervalSeconds * 1000);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

/**
 * Runs the device agent until interrupted, or until the dashboard tells us the credential is gone.
 */
export async function runDeviceAgent(token: string, manage?: string,
                                     options: DeviceAgentOptions = {}): Promise<void> {
    const wsUrl = buildDeviceAgentWsUrl(manage);
    const server = manage || "dashboard.pinggy.io";

    let identity: DeviceIdentity = readDeviceIdentity() ?? {
        device_agent_id: null, token, server, enrolled_at: null,
    };
    // A token passed on the command line always wins over what is on disk.
    identity = { ...identity, token, server };

    stopRequested = false;
    const sigintHandler = () => {
        stopRequested = true;
        cancelPendingSleep?.();
    };
    process.once("SIGINT", sigintHandler);

    const reconnectPolicy = options.reconnectPolicy ?? new ReconnectPolicy();
    const handshakeTimeoutMillis = options.handshakeTimeoutMillis ?? HANDSHAKE_TIMEOUT_MILLIS;

    while (!stopRequested) {
        CLIPrinter.print(`Connecting to ${server}`);
        const outcome = await connectOnce(wsUrl, identity, reconnectPolicy, handshakeTimeoutMillis);

        if (outcome === "terminal" || stopRequested) {
            break;
        }

        const delayMillis = reconnectPolicy.nextDelayMillis();
        CLIPrinter.warn(`Disconnected. Reconnecting in ${formatSeconds(delayMillis)} seconds `
            + `(attempt ${reconnectPolicy.attempt}).`);
        await sleep(delayMillis);
    }

    process.removeListener("SIGINT", sigintHandler);
}

type Outcome = "retry" | "terminal";

function connectOnce(wsUrl: string, identity: DeviceIdentity, reconnectPolicy: ReconnectPolicy,
                     handshakeTimeoutMillis: number): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { [TOKEN_HEADER]: identity.token } });

        let heartbeat: NodeJS.Timeout | null = null;
        let stopMetrics: (() => void) | null = null;
        let pingTimer: NodeJS.Timeout | null = null;
        let pongDeadline: NodeJS.Timeout | null = null;
        let handshakeDeadline: NodeJS.Timeout | null = null;
        let settled = false;

        const stopTimers = () => {
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = null;
            stopMetrics?.();
            stopMetrics = null;
            if (pingTimer) clearInterval(pingTimer);
            pingTimer = null;
            if (pongDeadline) clearTimeout(pongDeadline);
            pongDeadline = null;
            if (handshakeDeadline) clearTimeout(handshakeDeadline);
            handshakeDeadline = null;
        };

        const finish = (outcome: Outcome) => {
            if (settled) return;
            settled = true;
            stopTimers();
            if (reconnectPolicy.markDisconnected()) {
                logger.info("Connection held long enough to reset the reconnect schedule");
            }
            resolve(outcome);
        };

        const sendFrame = (frame: Envelope) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(frame));
            }
        };

        /**
         * Terminate, never close. A polite close waits for the peer to answer with a close frame,
         * and the peer is exactly what we have already decided is not answering.
         */
        const dropDeadSocket = (message: string) => {
            logger.warn(message);
            CLIPrinter.warn(message);
            ws.terminate();
        };

        ws.once("open", () => {
            logger.info("Device agent socket open, sending hello");
            sendFrame(request(CHANNEL_SYSTEM, OP_HELLO, buildHello()));

            handshakeDeadline = setTimeout(() => {
                dropDeadSocket("No welcome from the dashboard. Reconnecting.");
            }, handshakeTimeoutMillis);
        });

        // ws answers an inbound ping on its own (autoPong), so nothing is needed here. What is
        // missing without the block below is the other direction: this agent asking.
        const startPongWatchdog = (intervalSeconds: number) => {
            const intervalMillis = intervalSeconds * 1000;
            const graceMillis = intervalMillis * PONG_GRACE_INTERVALS;

            const armDeadline = () => {
                if (pongDeadline) clearTimeout(pongDeadline);
                pongDeadline = setTimeout(() => {
                    dropDeadSocket("Connection stopped answering. Reconnecting.");
                }, graceMillis);
            };

            ws.on("pong", armDeadline);
            pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, intervalMillis);
            armDeadline();
        };

        const startHeartbeat = (intervalSeconds: number) => {
            heartbeat = setInterval(() => sendFrame(
                event(CHANNEL_SYSTEM, OP_HEARTBEAT, { uptime_seconds: Math.floor(os.uptime()) })),
                intervalSeconds * 1000);
        };

        /**
         * The handshake completed. Only from here does the connection count as working, so a
         * dashboard that accepts upgrades and refuses every handshake never resets the backoff.
         *
         * Every cadence comes from welcome, the heartbeat and the metrics one alike. Never fall
         * back to a compiled-in default.
         */
        const onWelcome = (welcome: Welcome) => {
            stopTimers();
            reconnectPolicy.markConnected();
            startHeartbeat(welcome.heartbeat_interval_seconds);
            startPongWatchdog(welcome.heartbeat_interval_seconds);

            sendFrame(event(CHANNEL_DEVICE, OP_INFO, collectSystemInfo()));
            stopMetrics = startMetricsReporting(welcome.stats_interval_seconds, collectMetrics,
                (metrics) => sendFrame(event(CHANNEL_DEVICE, OP_METRICS, metrics)));
        };

        ws.on("message", (data) => {
            const envelope = parseEnvelope(data.toString("utf8"));
            if (!envelope) {
                logger.debug("Ignoring unparseable frame");
                return;
            }
            const outcome = handleFrame(envelope, identity, onWelcome);
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

function handleFrame(envelope: Envelope, identity: DeviceIdentity,
                     onWelcome: (welcome: Welcome) => void): Outcome {
    if (envelope.ch !== CHANNEL_SYSTEM) {
        // Unknown channels are ignored, never fatal. That is what lets the dashboard add a channel
        // this build has never heard of.
        logger.debug("Ignoring frame on unknown channel", { channel: envelope.ch });
        return "retry";
    }

    if (envelope.op === OP_WELCOME) {
        const error = ErrorPayloadSchema.safeParse(envelope.payload);
        if (error.success) {
            // Retryable: another node holds this device right now. The credential is fine, so
            // stopping would strand a machine that only needs to wait for the other socket to drop.
            if (error.data.error.code === ERROR_ALREADY_CONNECTED) {
                CLIPrinter.warn("This device is connected elsewhere. Retrying.");
                return "retry";
            }
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
        onWelcome(welcome.data);
        return "retry";
    }

    if (envelope.op === OP_DISCONNECT) {
        const disconnect = DisconnectSchema.safeParse(envelope.payload);
        const { outcome, message } = describeDisconnect(disconnect.success ? disconnect.data.reason : "unknown");
        if (outcome === "retry") {
            CLIPrinter.warn(message);
        } else {
            CLIPrinter.error(message);
        }
        return outcome;
    }

    logger.debug("Ignoring unhandled system op", { op: envelope.op });
    return "retry";
}

/** The only disconnect reason the agent reconnects on. The dashboard node is draining. */
const DISCONNECT_REASON_SHUTDOWN = "shutdown";

const DISCONNECT_MESSAGES: Record<string, string> = {
    revoked: "Credential revoked. Copy the new install command from the dashboard and run it to reconnect.",
    deleted: "Device deleted from the dashboard. Add it again to reconnect this machine.",
    replaced: "This device connected again from another session. Stopping this one.",
};

/**
 * What the agent does with `system/disconnect`, and what it prints. Every reason but `shutdown`
 * stops the agent: the dashboard follows the frame with close code 4001.
 */
export function describeDisconnect(reason: string): { outcome: "retry" | "terminal"; message: string } {
    if (reason === DISCONNECT_REASON_SHUTDOWN) {
        return { outcome: "retry", message: "Server is shutting down. Reconnecting." };
    }
    return {
        outcome: "terminal",
        message: DISCONNECT_MESSAGES[reason]
            ?? `Disconnected by the dashboard: ${reason}. Re-enrol this device to continue.`,
    };
}