import { logger } from "../../logger.js";
import { listSavedConfigs, SavedTunnelConfig } from "../../cli/configStore.js";
import {
    ensureDaemonRunning, getDaemonInfo, ipcMismatchMessage, isIpcCompatible,
} from "../../daemon/lifecycle/daemonManager.js";
import { IPCClient } from "../../daemon/ipc/ipcClient.js";
import { SessionMode } from "../../daemon/ipc/ipcRoutes.js";
import { TunnelConfigV1, TunnelConfigV1Schema } from "../../remote_management/remote_schema.js";
import { ErrorCode, isErrorResponse } from "../../types.js";
import { Envelope, OP_RESTART, OP_START, OP_STOP, response } from "../envelope.js";
import { TunnelAction, TunnelActionAnswer, TunnelActionSchema } from "../device_schema.js";
import { sanitizeErrorMessage } from "./tunnelList.js";

/**
 * `tunnel/start`, `tunnel/stop` and `tunnel/restart` from the dashboard's device page (slice 10).
 *
 * | Action                         | Daemon route                                  | May start a daemon |
 * | ------------------------------ | --------------------------------------------- | ------------------ |
 * | stop, by `tunnel_id`           | `POST /tunnels/stop`                          | no                 |
 * | restart, by `tunnel_id`        | `POST /tunnels/restart`, `noWait`             | no                 |
 * | start, by `tunnel_id`          | `POST /tunnels/restart`, `noWait`: same id    | no                 |
 * | start, `source: device`        | `POST /tunnels/start-config`, `noWait`        | yes                |
 * | start, `source: dashboard`     | `POST /tunnels/start-config`, `noWait`        | yes                |
 *
 * A saved config is read here and sent through `start-config`, rather than by name through
 * `POST /tunnels/start`, because only `start-config` takes `noWait`. The lookup is by exact
 * `config_id`, never the partial match `findConfig` allows.
 *
 * Start and restart answer when the daemon accepted them. `live`, or the error, arrives with the next
 * `device/tunnels` list. Stop answers when the daemon stopped the tunnel.
 *
 * **The dashboard config holds a token.** It goes to the daemon and nowhere else: no log line in
 * this file carries a config or a payload, only the op and the ids.
 *
 * See docs/pinggy-devices/slices/10-device-tunnel-actions.md in the pinggy_backend repo.
 */

export const ERROR_INVALID_PAYLOAD = "invalid_payload";
export const ERROR_UNSUPPORTED_OP = "unsupported_op";
export const ERROR_TUNNEL_NOT_FOUND = "tunnel_not_found";
export const ERROR_SAVED_CONFIG_NOT_FOUND = "saved_config_not_found";
export const ERROR_TUNNEL_ACTION_FAILED = "tunnel_action_failed";

/** What a start answers before the daemon reports a state of its own. */
const STATE_STARTING = "starting";

/** The daemon calls this file makes. A subset of IPCClient, so a test needs no daemon. */
export type TunnelDaemonClient = Pick<IPCClient, "stopTunnel" | "restartTunnel" | "startTunnelWithConfig">;

/** Thrown when a daemon is running but was built by another `pinggy` version. */
class DaemonUnusableError extends Error {}

export interface TunnelActionDependencies {
    /**
     * A client for the machine's daemon. Null when none is running and `startIfMissing` is false.
     * Throws when the one running cannot be used.
     */
    daemon(startIfMissing: boolean): Promise<TunnelDaemonClient | null>;
    readSavedConfigs(): SavedTunnelConfig[];
}

/** The real machine. Every call carries the `device` origin, so the daemon's logs say who asked. */
export const machineTunnelActionDependencies: TunnelActionDependencies = {
    async daemon(startIfMissing: boolean): Promise<TunnelDaemonClient | null> {
        const info = getDaemonInfo();
        if (info) {
            if (!isIpcCompatible(info)) {
                throw new DaemonUnusableError(ipcMismatchMessage(info));
            }
            return new IPCClient(info.port, "device");
        }
        if (!startIfMissing) {
            return null;
        }
        const started = await ensureDaemonRunning();
        return new IPCClient(started.port, "device");
    },
    readSavedConfigs: listSavedConfigs,
};

type ActionResult = TunnelActionAnswer | { error: { code: string; message: string } };

function failure(code: string, message: string): ActionResult {
    return { error: { code, message } };
}

function actionFailed(message: unknown): ActionResult {
    return failure(ERROR_TUNNEL_ACTION_FAILED, sanitizeErrorMessage(message) ?? "The tunnel action failed.");
}

const NO_DAEMON = failure(ERROR_TUNNEL_NOT_FOUND, "No tunnel daemon is running on this machine.");

/**
 * The daemon's answer, as the dashboard reads it. `TUNNEL_WITH_ID_OR_CONFIG_ID_NOT_FOUND` is the
 * daemon's code for an unknown tunnel on stop and restart; every other refusal is the daemon's own
 * message, cleaned and cut.
 */
function toResult(daemonAnswer: unknown, fallbackTunnelId: string | null): ActionResult {
    if (isErrorResponse(daemonAnswer)) {
        if (daemonAnswer.code === ErrorCode.TunnelNotFound) {
            return failure(ERROR_TUNNEL_NOT_FOUND, sanitizeErrorMessage(daemonAnswer.message) ?? "No such tunnel.");
        }
        return actionFailed(daemonAnswer.message);
    }
    const answer = (typeof daemonAnswer === "object" && daemonAnswer !== null ? daemonAnswer : {}) as {
        tunnelid?: unknown; status?: { state?: unknown };
    };
    const tunnelId = typeof answer.tunnelid === "string" && answer.tunnelid !== "" ? answer.tunnelid : fallbackTunnelId;
    if (!tunnelId) {
        return actionFailed("The daemon did not name the tunnel.");
    }
    const state = typeof answer.status?.state === "string" ? answer.status.state : STATE_STARTING;
    return { tunnel_id: tunnelId, state };
}

/** Drops keys whose value is null. The dashboard's serialiser writes them; the daemon's schema refuses them. */
function withoutNulls(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null));
}

/** Which of the 3 shapes, or null when the payload names none or several. */
function targetOf(op: string, action: TunnelAction):
    | { kind: "tunnel"; tunnelId: string }
    | { kind: "saved"; configId: string }
    | { kind: "dashboard"; config: Record<string, unknown> }
    | null {
    const namesTunnel = action.tunnel_id !== undefined;
    if (op !== OP_START) {
        return namesTunnel ? { kind: "tunnel", tunnelId: action.tunnel_id! } : null;
    }
    if (namesTunnel) {
        return action.source === undefined && action.config_id === undefined && action.config === undefined
            ? { kind: "tunnel", tunnelId: action.tunnel_id! } : null;
    }
    if (action.source === "device" && action.config_id !== undefined && action.config === undefined) {
        return { kind: "saved", configId: action.config_id };
    }
    if (action.source === "dashboard" && action.config !== undefined && action.config_id === undefined) {
        return { kind: "dashboard", config: action.config };
    }
    return null;
}

async function perform(op: string, action: TunnelAction, dependencies: TunnelActionDependencies): Promise<ActionResult> {
    const target = targetOf(op, action);
    if (!target) {
        return failure(ERROR_INVALID_PAYLOAD, "The tunnel request names no tunnel or config.");
    }

    if (target.kind === "tunnel") {
        // Stop, restart, and start of a stopped tunnel all need a tunnel the daemon already holds, so
        // none of them starts a daemon. With none running, there is nothing to act on.
        const client = await dependencies.daemon(false);
        if (!client) {
            return NO_DAEMON;
        }
        const answer = op === OP_STOP
            ? await client.stopTunnel(target.tunnelId)
            // The daemon keeps a stopped tunnel, and restart starts it again under the same id.
            : await client.restartTunnel(target.tunnelId, true);
        return toResult(answer, target.tunnelId);
    }

    let config: TunnelConfigV1;
    if (target.kind === "saved") {
        const saved = dependencies.readSavedConfigs().find((candidate) => candidate.configId === target.configId);
        if (!saved) {
            return failure(ERROR_SAVED_CONFIG_NOT_FOUND, "No config with that id is saved on this machine.");
        }
        // The same shape the daemon's own start-by-name route builds.
        config = { ...saved.tunnelConfig, configId: saved.configId, name: saved.name } as TunnelConfigV1;
    } else {
        const parsed = TunnelConfigV1Schema.safeParse(withoutNulls(target.config));
        if (!parsed.success) {
            // The issues name fields, and a field's value may be the token. Neither is logged.
            return failure(ERROR_INVALID_PAYLOAD, "The dashboard config could not be read.");
        }
        config = parsed.data;
    }

    const client = await dependencies.daemon(true);
    if (!client) {
        return actionFailed("The tunnel daemon could not be started.");
    }
    return toResult(await client.startTunnelWithConfig(config, SessionMode.Detached, true), null);
}

/**
 * Carries out 1 frame on the `tunnel` channel and sends its answer on the same id and op. Never
 * throws: a daemon that is down, refuses, or answers something unreadable becomes an error answer.
 */
export async function handleTunnelAction(envelope: Envelope, send: (frame: Envelope) => void,
                                         dependencies: TunnelActionDependencies = machineTunnelActionDependencies):
    Promise<void> {
    if (envelope.kind !== "req") {
        return;
    }
    const op = envelope.op;
    if (op !== OP_START && op !== OP_STOP && op !== OP_RESTART) {
        send(response(envelope, op, failure(ERROR_UNSUPPORTED_OP, `Unsupported operation: tunnel/${op}`)));
        return;
    }

    const parsed = TunnelActionSchema.safeParse(envelope.payload);
    if (!parsed.success) {
        send(response(envelope, op, failure(ERROR_INVALID_PAYLOAD, "The tunnel request could not be read.")));
        return;
    }

    let result: ActionResult;
    try {
        result = await perform(op, parsed.data, dependencies);
    } catch (err) {
        // The message only. Nothing here quotes a config.
        result = actionFailed(err instanceof Error ? err.message : String(err));
    }

    logger.info("Device agent tunnel action", {
        op,
        tunnelId: parsed.data.tunnel_id ?? null,
        configId: parsed.data.config_id ?? null,
        source: parsed.data.source ?? null,
        outcome: "error" in result ? result.error.code : "accepted",
    });
    send(response(envelope, op, result));
}
