import WebSocket from "ws";
import os from "os";
import { logger } from "../logger.js";
import { getVersion } from "../utils/util.js";
import { DeviceAgentError } from "../daemon/ipc/ipcRoutes.js";
import {
    CHANNEL_DEVICE, CHANNEL_SYSTEM, CHANNEL_TUNNEL, Envelope, OP_DISCONNECT, OP_HEARTBEAT, OP_HELLO, OP_INFO, OP_METRICS,
    OP_TUNNELS, OP_WELCOME, event, parseEnvelope, request,
} from "./envelope.js";
import {
    DeviceMetrics, DisconnectSchema, ErrorPayloadSchema, Hello, Welcome, WelcomeSchema,
} from "./device_schema.js";
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from "./deviceIdentity.js";
import { DeviceAgentReporter, printingReporter } from "./deviceAgentReporter.js";
import { collectSystemInfo } from "./collectors/systemInfo.js";
import { collectMetrics } from "./collectors/metrics.js";
import { TunnelListSource, TunnelReporting, collectTunnelList, startTunnelReporting } from "./tunnels/tunnelList.js";
import { TunnelActionDependencies, handleTunnelAction } from "./tunnels/tunnelActions.js";
import { ReconnectPolicy } from "./reconnect.js";
import { CHANNEL_TERMINAL } from "./terminal/terminal_schema.js";
import { TerminalHandler } from "./terminal/terminalHandler.js";
import { isScreenMirrorSupported } from "./terminal/screenMirror.js";
import { TerminalRegistry } from "./terminal/terminalRegistry.js";
import { PtySession, isTerminalSupported, spawnPty } from "./terminal/ptySession.js";
import { readShellEnvironment, resolveShell } from "./terminal/shellAllowlist.js";
import { processTableReader, resolvedHomeDirectory } from "./terminal/shellContext.js";

export { printConnected } from "./deviceAgentReporter.js";

/** The dashboard closes with this after sending system/disconnect. Terminal: never retry. */
const CLOSE_CODE_REVOKED = 4001;

/** The close code `stop()` sends: this side is going away on purpose. */
const CLOSE_CODE_NORMAL = 1000;

/** How long `stop()` waits for the dashboard's close frame before it drops the socket. */
const CLOSE_TIMEOUT_MILLIS = 3_000;

const TOKEN_HEADER = "X-Pinggy-Device-Token";

/** The dashboard a run dials when no server is given. device.json records it under this name. */
export const DEFAULT_SERVER = "dashboard.pinggy.io";

/** Retryable handshake refusal: a live node elsewhere still holds this device. */
const ERROR_ALREADY_CONNECTED = "already_connected";

/** `DeviceAgentError.code` for each way a run ends for good. A disconnect reason is its own code. */
export const AGENT_ERROR_UNAUTHORIZED = "unauthorized";
export const AGENT_ERROR_HANDSHAKE_REFUSED = "handshake_refused";
export const AGENT_ERROR_DISCONNECTED = "disconnected";
/** A verify run (`verifyOnly`) got no `welcome` on its 1 attempt. */
export const AGENT_ERROR_NOT_CONNECTED = "not_connected";

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

/**
 * `tunnel` has been advertised since slice 01 and never meant anything. `tunnel_control` (slice 10)
 * is what lets the dashboard send start, stop and restart. `tunnel_update` (slice 10b) lets it send
 * update. It is separate because a slice 10 agent has `tunnel_control` and does not know update.
 * `saved_config_update` lets it send an update that rewrites a config saved on the machine, which a
 * slice 10b agent refuses.
 */
const BASE_CAPABILITIES = ["tunnel", "stats", "tunnel_control", "tunnel_update", "saved_config_update"];
const CAPABILITY_TERMINAL = "terminal";
const CAPABILITY_TERMINAL_SNAPSHOT = "terminal_snapshot";

/**
 * `terminal` only when node-pty actually loads here. It is what un-greys the Terminal button, so an
 * agent that advertises it must be able to serve it.
 *
 * `terminal_snapshot` (slice T6) only beside `terminal`, and only when the headless terminal loads.
 * The dashboard asks for a screen only from an agent that advertises it.
 */
export function buildCapabilities(terminalSupported: boolean, screenRestoreSupported = false): string[] {
    if (!terminalSupported) return BASE_CAPABILITIES;
    return screenRestoreSupported
        ? [...BASE_CAPABILITIES, CAPABILITY_TERMINAL, CAPABILITY_TERMINAL_SNAPSHOT]
        : [...BASE_CAPABILITIES, CAPABILITY_TERMINAL];
}

/**
 * What a host changes about a run. Production's foreground agent passes nothing.
 *
 * A test overrides the 2 things it cannot wait out: a 60 s backoff and a 30 s handshake timer. The daemon
 * (`pinggy device connect -b`) passes its own reporter, its own port for the tunnel list and actions, and
 * a `device.json` writer that leaves a newer credential alone.
 */
export interface DeviceAgentOptions {
    reconnectPolicy?: ReconnectPolicy;
    handshakeTimeoutMillis?: number;
    /** Default: the foreground agent's terminal output. */
    reporter?: DeviceAgentReporter;
    /** Where `device/tunnels` reads. Default: the daemon named in daemon.json. */
    tunnelListSource?: TunnelListSource;
    /** How `tunnel/*` requests reach a daemon. Default: the daemon named in daemon.json. */
    tunnelActions?: TunnelActionDependencies;
    /** Writes device.json on each `welcome`. Default: `writeDeviceIdentity`. */
    writeIdentity?: (identity: DeviceIdentity) => void;
    /**
     * 1 attempt, ended at the 1st `welcome` before any timer starts. `connect -b` checks a new token this
     * way, so a token the dashboard refuses never reaches device.json or the daemon.
     */
    verifyOnly?: boolean;
}

/** How a run ended. */
export interface DeviceAgentEnd {
    /** Set when the dashboard refused the credential or ended the device. Null after `stop()`. */
    error: DeviceAgentError | null;
    /** A `welcome` arrived during the run. */
    welcomed: boolean;
}

/** 1 run of the agent loop. */
export interface DeviceAgentRun {
    /** Cancels a backoff sleep and closes the live socket with 1000. Resolves when the loop has ended. */
    stop(): Promise<DeviceAgentEnd>;
    /** Resolves when the loop has ended, by `stop()` or for good. Every shell is closed by then. */
    readonly done: Promise<DeviceAgentEnd>;
}

/** What the loop and the socket handlers share for 1 run. */
interface RunState {
    stopRequested: boolean;
    /** Set while the loop sleeps between attempts. */
    cancelPendingSleep: (() => void) | null;
    error: DeviceAgentError | null;
    welcomed: boolean;
}

/** The socket in use, as the run's other parts see it. Both are null while no socket is open. */
interface Connection {
    send: ((frame: Envelope) => void) | null;
    close: (() => void) | null;
}

interface RunContext {
    wsUrl: string;
    server: string;
    identity: DeviceIdentity;
    reconnectPolicy: ReconnectPolicy;
    handshakeTimeoutMillis: number;
    terminalHandler: TerminalHandler;
    connection: Connection;
    reporter: DeviceAgentReporter;
    writeIdentity: (identity: DeviceIdentity) => void;
    options: DeviceAgentOptions;
    state: RunState;
}

export function buildDeviceAgentWsUrl(manage?: string): string {
    let baseUrl = (manage || DEFAULT_SERVER).trim();
    if (!(baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://"))) {
        baseUrl = "wss://" + baseUrl;
    }
    return `${baseUrl.replace(/\/$/, "")}/backend/api/v1/device-agent/ws/connect`;
}

/** Resolves early when the run stops, so a stop is not held up by the backoff. */
function sleep(millis: number, state: RunState): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            state.cancelPendingSleep = null;
            resolve();
        }, millis);

        state.cancelPendingSleep = () => {
            clearTimeout(timer);
            state.cancelPendingSleep = null;
            resolve();
        };
    });
}

function buildHello(terminalHandler: TerminalHandler): Hello {
    return {
        agent_version: getVersion(),
        os: os.platform(),
        hostname: os.hostname(),
        capabilities: buildCapabilities(isTerminalSupported(), isScreenMirrorSupported()),
        terminals: terminalHandler.held(),
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
 * The identity this run writes on `welcome`. The stored one only while it holds the same token: a
 * different token is another device, so the old `device_agent_id` and `enrolled_at` do not carry over.
 * The old device stays in the dashboard, offline.
 */
export function identityForRun(token: string, server: string, stored: DeviceIdentity | null): DeviceIdentity {
    if (stored?.token === token) {
        return { ...stored, server };
    }
    return { device_agent_id: null, token, server, enrolled_at: null };
}

/**
 * Starts the agent loop and returns at once. It runs until `stop()`, or until the dashboard says the
 * credential is gone. Installs no signal handler: the daemon and the Pinggy app own their signals.
 */
export function startDeviceAgent(token: string, manage?: string, options: DeviceAgentOptions = {}): DeviceAgentRun {
    const server = manage || DEFAULT_SERVER;
    const reporter = options.reporter ?? printingReporter;
    const stored = readDeviceIdentity();
    if (stored?.device_agent_id && stored.token !== token) {
        reporter.replacingDevice(stored.device_agent_id);
    }

    // 1 for the whole run, not 1 per socket: a shell outlives the connection that opened it. Frames
    // go to whichever socket is live, and are dropped while none is.
    const connection: Connection = { send: null, close: null };
    const context: RunContext = {
        wsUrl: buildDeviceAgentWsUrl(manage),
        server,
        identity: identityForRun(token, server, stored),
        reconnectPolicy: options.reconnectPolicy ?? new ReconnectPolicy(),
        handshakeTimeoutMillis: options.handshakeTimeoutMillis ?? HANDSHAKE_TIMEOUT_MILLIS,
        terminalHandler: new TerminalHandler({
            send: (frame) => connection.send?.(frame),
            spawn: spawnPty,
            resolveShell: (requested) => resolveShell(requested, readShellEnvironment()),
            registry: new TerminalRegistry<PtySession>(),
            readShellContexts: processTableReader(),
            resolvedHome: resolvedHomeDirectory(),
        }),
        connection,
        reporter,
        writeIdentity: options.writeIdentity ?? writeDeviceIdentity,
        options,
        state: { stopRequested: false, cancelPendingSleep: null, error: null, welcomed: false },
    };

    const done = runLoop(context);
    return {
        done,
        stop: () => {
            context.state.stopRequested = true;
            context.state.cancelPendingSleep?.();
            connection.close?.();
            return done;
        },
    };
}

/**
 * The foreground agent: runs until Ctrl+C, or until the dashboard says the credential is gone. The 1st
 * Ctrl+C stops the run. The 2nd reaches Node's default handler and exits at once.
 */
export async function runDeviceAgent(token: string, manage?: string,
                                     options: DeviceAgentOptions = {}): Promise<void> {
    const run = startDeviceAgent(token, manage, options);
    const sigintHandler = () => {
        void run.stop();
    };
    process.once("SIGINT", sigintHandler);
    try {
        await run.done;
    } finally {
        process.removeListener("SIGINT", sigintHandler);
    }
}

async function runLoop(context: RunContext): Promise<DeviceAgentEnd> {
    const { state, reporter, reconnectPolicy } = context;
    while (!state.stopRequested) {
        reporter.connecting(context.server);
        const outcome = await connectOnce(context);

        if (outcome === "terminal" || state.stopRequested) {
            break;
        }
        if (context.options.verifyOnly) {
            state.error = {
                code: AGENT_ERROR_NOT_CONNECTED,
                message: `Could not connect to ${context.server}. Check the address and the network, then try again.`,
            };
            break;
        }

        const delayMillis = reconnectPolicy.nextDelayMillis();
        reporter.reconnecting(delayMillis, reconnectPolicy.attempt);
        await sleep(delayMillis, state);
    }

    // Stopped for good: stopped, revoked, or refused. This, and the process dying, are the only ways a
    // shell ends from this side.
    context.terminalHandler.closeAll();
    return { error: state.error, welcomed: state.welcomed };
}

type Outcome = "retry" | "terminal";

/** Records why the run ends, tells the host, and ends it. */
function fail(context: RunContext, error: DeviceAgentError): Outcome {
    context.state.error = error;
    context.reporter.failed(error);
    return "terminal";
}

function connectOnce(context: RunContext): Promise<Outcome> {
    const { identity, reconnectPolicy, terminalHandler, connection, reporter, state, options } = context;
    return new Promise<Outcome>((resolve) => {
        const ws = new WebSocket(context.wsUrl, { headers: { [TOKEN_HEADER]: identity.token } });

        let heartbeat: NodeJS.Timeout | null = null;
        let stopMetrics: (() => void) | null = null;
        let stopTunnels: TunnelReporting | null = null;
        let pingTimer: NodeJS.Timeout | null = null;
        let pongDeadline: NodeJS.Timeout | null = null;
        let handshakeDeadline: NodeJS.Timeout | null = null;
        let closeDeadline: NodeJS.Timeout | null = null;
        let settled = false;

        const stopTimers = () => {
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = null;
            stopMetrics?.();
            stopMetrics = null;
            stopTunnels?.();
            stopTunnels = null;
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
            if (closeDeadline) clearTimeout(closeDeadline);
            closeDeadline = null;
            if (reconnectPolicy.markDisconnected()) {
                logger.info("Connection held long enough to reset the reconnect schedule");
            }
            // Keep the shells for the next socket. A terminal outcome kills them once the loop ends.
            connection.send = null;
            connection.close = null;
            terminalHandler.suspend();
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
            reporter.warn(message);
            ws.terminate();
        };

        /** `stop()`: a polite close, then a drop if the dashboard does not answer it in time. */
        connection.close = () => {
            if (ws.readyState === WebSocket.CONNECTING) {
                ws.terminate();
                return;
            }
            ws.close(CLOSE_CODE_NORMAL);
            closeDeadline = setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MILLIS);
        };

        ws.once("open", () => {
            logger.info("Device agent socket open, sending hello");
            // Before hello: the dashboard's reconcile can close a shell before it answers.
            connection.send = sendFrame;
            sendFrame(request(CHANNEL_SYSTEM, OP_HELLO, buildHello(terminalHandler)));

            handshakeDeadline = setTimeout(() => {
                dropDeadSocket("No welcome from the dashboard. Reconnecting.");
            }, context.handshakeTimeoutMillis);
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
            if (options.verifyOnly) {
                // The token works, and device.json now holds it. The daemon dials next, so this socket ends.
                state.stopRequested = true;
                connection.close?.();
                return;
            }
            reconnectPolicy.markConnected();
            terminalHandler.configure(welcome.terminal_enabled, welcome.max_terminals_per_device,
                welcome.terminal_window_bytes, welcome.max_frame_bytes,
                welcome.terminal_idle_timeout_seconds, welcome.terminal_max_session_seconds);
            terminalHandler.resumeAll();
            startHeartbeat(welcome.heartbeat_interval_seconds);
            startPongWatchdog(welcome.heartbeat_interval_seconds);

            sendFrame(event(CHANNEL_DEVICE, OP_INFO, collectSystemInfo()));
            stopMetrics = startMetricsReporting(welcome.stats_interval_seconds, collectMetrics,
                (metrics) => sendFrame(event(CHANNEL_DEVICE, OP_METRICS, metrics)));
            // Reads the daemon, never starts one. Sends once now, then only on change.
            stopTunnels = startTunnelReporting(() => collectTunnelList(options.tunnelListSource),
                (tunnels) => sendFrame(event(CHANNEL_DEVICE, OP_TUNNELS, tunnels)));
        };

        ws.on("message", (data) => {
            const envelope = parseEnvelope(data.toString("utf8"));
            if (!envelope) {
                logger.debug("Ignoring unparseable frame");
                return;
            }
            if (envelope.ch === CHANNEL_TERMINAL) {
                terminalHandler.handle(envelope);
                return;
            }
            if (envelope.ch === CHANNEL_TUNNEL) {
                // Answers on this socket, or on the next one if it dropped meanwhile, or not at all.
                // The dashboard's browser times out on its own. Then the list is read at once, so the
                // page shows the action's effect without waiting out the 5 s poll.
                void handleTunnelAction(envelope, (frame) => connection.send?.(frame), options.tunnelActions)
                    .then(() => stopTunnels?.pollNow());
                return;
            }
            const outcome = handleFrame(envelope, context, onWelcome);
            if (outcome === "terminal") {
                finish("terminal");
                ws.close();
            }
        });

        ws.on("unexpected-response", (_req, res) => {
            if (res.statusCode === 401) {
                finish(fail(context, {
                    code: AGENT_ERROR_UNAUTHORIZED,
                    message: "Unauthorized. This device token is not valid. Re-enrol this machine with: "
                        + "pinggy device login",
                }));
            } else {
                reporter.warn(`Unexpected HTTP ${res.statusCode}.`);
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
            // A stop that ends a dial in progress raises an error of its own. It says nothing new.
            if (!state.stopRequested) {
                reporter.warn(err.message);
            }
            finish("retry");
        });
    });
}

function handleFrame(envelope: Envelope, context: RunContext, onWelcome: (welcome: Welcome) => void): Outcome {
    const { identity, reporter } = context;
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
                reporter.warn("This device is connected elsewhere. Retrying.");
                return "retry";
            }
            return fail(context, {
                code: AGENT_ERROR_HANDSHAKE_REFUSED,
                message: `Handshake refused: ${error.data.error.message}`,
            });
        }

        const welcome = WelcomeSchema.safeParse(envelope.payload);
        if (!welcome.success) {
            logger.warn("Welcome payload could not be read");
            return "retry";
        }

        identity.device_agent_id = welcome.data.device_agent_id;
        identity.enrolled_at = identity.enrolled_at ?? new Date().toISOString();
        context.writeIdentity(identity);
        context.state.welcomed = true;

        reporter.connected(welcome.data);
        // Every cadence comes from welcome. Never fall back to a compiled-in default.
        onWelcome(welcome.data);
        return "retry";
    }

    if (envelope.op === OP_DISCONNECT) {
        const disconnect = DisconnectSchema.safeParse(envelope.payload);
        const reason = disconnect.success ? disconnect.data.reason : "unknown";
        const { outcome, message } = describeDisconnect(reason);
        if (outcome === "retry") {
            reporter.warn(message);
            return "retry";
        }
        return fail(context, { code: disconnectErrorCode(reason), message });
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

/** A known reason is its own code. Any other is `disconnected`. */
function disconnectErrorCode(reason: string): string {
    return reason in DISCONNECT_MESSAGES ? reason : AGENT_ERROR_DISCONNECTED;
}

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
