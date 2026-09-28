import { logger } from "../../logger.js";
import { listSavedConfigs, SavedTunnelConfig } from "../../cli/configStore.js";
import { getDaemonInfo, isIpcCompatible } from "../../daemon/lifecycle/daemonManager.js";
import { IPCClient } from "../../daemon/ipc/ipcClient.js";
import { TunnelStateType } from "../../types.js";
import {
    DeviceSavedTunnelConfig, DeviceTunnel, DeviceTunnelForwarding, DeviceTunnelList,
} from "../device_schema.js";

/**
 * `device/tunnels`: what the machine's daemon holds, and what is saved on disk.
 *
 * A whitelist. Every field that leaves this machine is named below, one by one, from the
 * daemon's answer. Nothing is spread. The tunnel config holds the token, basic auth passwords,
 * bearer tokens and header values, and a field added to it later stays here until someone adds it
 * to this file on purpose.
 *
 * Reads only. This file never starts a daemon: `getDaemonInfo()` checks the pid and spawns nothing.
 *
 * See docs/pinggy-devices/slices/09-device-tunnels.md in the pinggy_backend repo.
 */

/** A localhost HTTP call, cheap. Stats are left out of the rows, so a poll that sees no change sends nothing. */
export const TUNNEL_POLL_INTERVAL_MILLIS = 5_000;

/** The frame limit is 32 KB. A machine with more is not the case the device page is for. */
export const MAX_TUNNELS = 50;
export const MAX_SAVED_CONFIGS = 100;

export const ERROR_MESSAGE_MAX_LENGTH = 256;

/** The daemon is alive but was built by another `pinggy` version. Its answer is not parsed. */
export const REASON_IPC_VERSION_MISMATCH = "ipc_version_mismatch";

/** daemon.json names a live pid, but the IPC port does not answer. */
export const REASON_DAEMON_UNREACHABLE = "daemon_unreachable";

const FORWARDING_TYPES = new Set(["http", "tcp", "udp", "tls", "tlstcp"]);
const DEFAULT_FORWARDING_TYPE = "http";
const MODES = new Set(["foreground", "detached"]);
const STATES = new Set<string>(Object.values(TunnelStateType));
const STOPPED_STATES = new Set<string>([TunnelStateType.Closed, TunnelStateType.Exited]);

/** What the daemon answered, before the whitelist. */
export type DaemonReading =
    | { running: true; tunnels: unknown[] }
    | { running: false; reason: string | null };

/** The 2 things the list reads. Injected so a test needs neither a daemon nor a config dir. */
export interface TunnelListSource {
    readDaemon(): Promise<DaemonReading>;
    readSavedConfigs(): SavedTunnelConfig[];
}

/** The real machine: `daemon.json`, `GET /tunnels`, and the `tunnels/` config dir. */
export const machineTunnelListSource: TunnelListSource = {
    async readDaemon(): Promise<DaemonReading> {
        const info = getDaemonInfo();
        if (!info) {
            return { running: false, reason: null };
        }
        // The same refusal as ensureDaemonRunning, without its fallback of starting one.
        if (!isIpcCompatible(info)) {
            return { running: false, reason: REASON_IPC_VERSION_MISMATCH };
        }
        try {
            const answer = await new IPCClient(info.port, "cli").listTunnels();
            return { running: true, tunnels: Array.isArray(answer) ? answer : [] };
        } catch (err) {
            logger.debug("Device agent could not list the daemon's tunnels", { error: String(err) });
            return { running: false, reason: REASON_DAEMON_UNREACHABLE };
        }
    },
    readSavedConfigs: listSavedConfigs,
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** ISO 8601 from the daemon, unix seconds on the wire. Null for an empty or unreadable time. */
export function toEpochSeconds(value: unknown): number | null {
    if (typeof value !== "string" || value === "") return null;
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? null : Math.floor(millis / 1000);
}

/** Control characters dropped, cut to 256. An error message is text for a browser, never a terminal. */
export function sanitizeErrorMessage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    // eslint-disable-next-line no-control-regex
    const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    return printable === "" ? null : printable.slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

function forwardingType(value: unknown): string {
    return typeof value === "string" && FORWARDING_TYPES.has(value) ? value : DEFAULT_FORWARDING_TYPE;
}

/**
 * A string forwarding (`"https://localhost:5555"`) becomes 1 entry, its scheme read as the type. An
 * array keeps `type` and `address` of each entry, and nothing else.
 */
export function toForwarding(forwarding: unknown): DeviceTunnelForwarding[] {
    if (typeof forwarding === "string") {
        if (forwarding.trim() === "") return [];
        const schemeMatch = /^([a-z]+):\/\/(.+)$/i.exec(forwarding.trim());
        if (!schemeMatch) {
            return [{ type: DEFAULT_FORWARDING_TYPE, local_address: forwarding.trim() }];
        }
        const scheme = schemeMatch[1].toLowerCase();
        return [{ type: scheme === "https" ? DEFAULT_FORWARDING_TYPE : forwardingType(scheme),
                  local_address: schemeMatch[2] }];
    }
    if (!Array.isArray(forwarding)) return [];
    return forwarding
        .filter(isObject)
        .filter((entry) => typeof entry.address === "string")
        .map((entry) => ({ type: forwardingType(entry.type), local_address: entry.address as string }));
}

/** 1 row, from named fields of 1 entry of `GET /tunnels`. Null for an entry without an id. */
export function toTunnelRow(daemonTunnel: unknown): DeviceTunnel | null {
    if (!isObject(daemonTunnel) || typeof daemonTunnel.tunnelid !== "string") return null;
    const config = isObject(daemonTunnel.tunnelconfig) ? daemonTunnel.tunnelconfig : {};
    const status = isObject(daemonTunnel.status) ? daemonTunnel.status : {};
    const remoteUrls = Array.isArray(daemonTunnel.remoteurls)
        ? daemonTunnel.remoteurls.filter((url): url is string => typeof url === "string")
        : [];

    return {
        tunnel_id: daemonTunnel.tunnelid,
        config_id: stringOrNull(config.configId),
        name: stringOrNull(config.name),
        state: typeof status.state === "string" && STATES.has(status.state) ? status.state : TunnelStateType.New,
        error_message: sanitizeErrorMessage(status.errormsg),
        remote_urls: remoteUrls,
        forwarding: toForwarding(config.forwarding),
        mode: typeof daemonTunnel.mode === "string" && MODES.has(daemonTunnel.mode) ? daemonTunnel.mode : null,
        created_at: toEpochSeconds(status.createdtimestamp),
        started_at: toEpochSeconds(status.starttimestamp),
    };
}

function newestFirst<T>(rows: T[], timeOf: (row: T) => number | null): T[] {
    return [...rows].sort((a, b) => (timeOf(b) ?? 0) - (timeOf(a) ?? 0));
}

/** The whole payload, from what was read. Pure, so the whitelist is testable without a daemon. */
export function buildTunnelList(reading: DaemonReading, savedConfigs: SavedTunnelConfig[],
                                collectedAtEpochSeconds: number): DeviceTunnelList {
    const allTunnels = reading.running
        ? newestFirst(reading.tunnels.map(toTunnelRow).filter((row): row is DeviceTunnel => row !== null),
                      (row) => row.created_at)
        : [];
    const runningConfigIds = new Set(allTunnels
        .filter((row) => row.config_id !== null && !STOPPED_STATES.has(row.state))
        .map((row) => row.config_id));

    const allSaved: DeviceSavedTunnelConfig[] = newestFirst(savedConfigs, (config) => toEpochSeconds(config.createdAt))
        .map((config) => ({
            config_id: config.configId,
            name: config.name,
            running: runningConfigIds.has(config.configId),
        }));

    return {
        daemon_running: reading.running,
        daemon_unavailable_reason: reading.running ? null : reading.reason,
        tunnels: allTunnels.slice(0, MAX_TUNNELS),
        saved_configs: allSaved.slice(0, MAX_SAVED_CONFIGS),
        truncated: allTunnels.length > MAX_TUNNELS || allSaved.length > MAX_SAVED_CONFIGS,
        collected_at: collectedAtEpochSeconds,
    };
}

export async function collectTunnelList(source: TunnelListSource = machineTunnelListSource): Promise<DeviceTunnelList> {
    const reading = await source.readDaemon();
    let savedConfigs: SavedTunnelConfig[] = [];
    try {
        savedConfigs = source.readSavedConfigs();
    } catch (err) {
        logger.debug("Device agent could not read saved tunnel configs", { error: String(err) });
    }
    return buildTunnelList(reading, savedConfigs, Math.floor(Date.now() / 1000));
}

/**
 * What change detection compares: the serialised rows without `collected_at`, and nothing else. A
 * field that moves on its own would turn every poll into a push.
 */
export function changeKey(list: DeviceTunnelList): string {
    const { collected_at: _collectedAt, ...comparable } = list;
    return JSON.stringify(comparable);
}

/** Stops the reporting when called. `pollNow` reads the daemon at once, outside the interval. */
export interface TunnelReporting {
    (): void;
    pollNow(): void;
}

/**
 * Sends the list at once, then polls every `intervalMillis` and sends only when it changed, until
 * the returned function is called.
 *
 * Called once per `welcome`, so every new socket gets the list once whether or not it changed. A
 * poll still running when the next one is due is not overlapped. `pollNow` (slice 10) is called after
 * a tunnel action, so the page shows its effect without waiting out the interval. Asked while a read
 * is in flight, it reads again once that one ends: the read in flight may predate the action.
 */
export function startTunnelReporting(collect: () => Promise<DeviceTunnelList>,
                                     send: (list: DeviceTunnelList) => void,
                                     intervalMillis: number = TUNNEL_POLL_INTERVAL_MILLIS): TunnelReporting {
    let stopped = false;
    let inFlight = false;
    let pollAgain = false;
    let lastSentKey: string | null = null;

    const poll = () => {
        if (stopped) return;
        if (inFlight) {
            pollAgain = true;
            return;
        }
        inFlight = true;
        collect()
            .then((list) => {
                // A list still being read when the socket closed is dropped, not sent late.
                if (stopped) return;
                const key = changeKey(list);
                if (key === lastSentKey) return;
                lastSentKey = key;
                send(list);
            })
            .catch((err) => logger.warn("Device tunnel list collection failed", { error: String(err) }))
            .finally(() => {
                inFlight = false;
                if (pollAgain) {
                    pollAgain = false;
                    poll();
                }
            });
    };

    poll();
    const timer = setInterval(poll, intervalMillis);
    const stop = () => {
        stopped = true;
        clearInterval(timer);
    };
    return Object.assign(stop, { pollNow: poll });
}
