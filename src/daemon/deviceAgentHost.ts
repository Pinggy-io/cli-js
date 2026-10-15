import { logger } from "../logger.js";
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from "../devices/deviceIdentity.js";
import { DeviceAgentEnd, DeviceAgentRun, startDeviceAgent } from "../devices/deviceAgent.js";
import { DeviceAgentReporter } from "../devices/deviceAgentReporter.js";
import { selfTunnelListSource } from "../devices/tunnels/tunnelList.js";
import { selfTunnelActionDependencies } from "../devices/tunnels/tunnelActions.js";
import { TunnelOrigin } from "../tunnel_manager/TunnelManager.js";
import { ErrorCode, ErrorResponse, newErrorResponse } from "../types.js";
import { DeviceAgentState, DeviceAgentStatus } from "./ipc/ipcRoutes.js";

/**
 * The device agent a daemon runs for `pinggy devices connect -b`. At most 1 run at a time.
 *
 * Whoever hosts the daemon hosts the agent: the CLI's detached child, a system service, or the Pinggy app.
 * `GET /device`, `POST /device/start` and `POST /device/stop` reach it. No route carries a token or a
 * server: the run reads both from device.json, which only this user can write. Any local user can reach
 * the IPC port, and a route that took a token would let another user point this user's shell at their own
 * account.
 *
 * Start and stop run 1 at a time, so 2 runs never share 1 credential inside 1 daemon.
 *
 * See docs/pinggy-devices/slices/17-background-agent.md in the pinggy_backend repo.
 */

export const NOT_ENROLLED_MESSAGE = "This machine is not enrolled. Sign it in first: pinggy devices login";

export interface DeviceAgentHostDependencies {
    readIdentity(): DeviceIdentity | null;
    startRun(identity: DeviceIdentity, reporter: DeviceAgentReporter): DeviceAgentRun;
    /** Records the run in daemon-state.json, so a crashed daemon starts it again. */
    recordRunning(startedBy: TunnelOrigin): void;
    recordStopped(): void;
    now(): Date;
}

interface CurrentRun {
    run: DeviceAgentRun;
    token: string;
    server: string;
}

function stoppedStatus(): DeviceAgentStatus {
    return {
        state: DeviceAgentState.Stopped,
        deviceAgentId: null,
        server: null,
        email: null,
        deviceUrl: null,
        startedAt: null,
        connectedAt: null,
        startedBy: null,
        lastError: null,
    };
}

export class DeviceAgentHost {
    private current: CurrentRun | null = null;
    private statusValue: DeviceAgentStatus = stoppedStatus();
    /** Bumped on every start and stop. A run's reporter whose number is old belongs to a run that ended. */
    private generation = 0;
    /** Set once the daemon shuts down. Nothing starts and nothing more reaches daemon-state.json. */
    private closed = false;
    /** Start and stop chain on this, so 1 finishes before the next begins. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly dependencies: DeviceAgentHostDependencies) {}

    status(): DeviceAgentStatus {
        return { ...this.statusValue };
    }

    /**
     * Starts the agent on what device.json holds now. A run on the same token and server is left alone.
     * A run on another is stopped first.
     */
    start(startedBy: TunnelOrigin): Promise<DeviceAgentStatus | ErrorResponse> {
        return this.exclusive(async () => {
            if (this.closed) {
                return this.status();
            }
            const identity = this.dependencies.readIdentity();
            if (!identity?.token) {
                return newErrorResponse(ErrorCode.DeviceNotEnrolled, NOT_ENROLLED_MESSAGE);
            }
            const current = this.current;
            if (current && current.token === identity.token && current.server === identity.server) {
                return this.status();
            }
            await this.stopCurrent();
            this.launch(identity, startedBy);
            return this.status();
        });
    }

    /** Stops the run: the socket closes with 1000 and every shell ends. */
    stop(): Promise<DeviceAgentStatus> {
        return this.exclusive(async () => {
            await this.stopCurrent();
            return this.status();
        });
    }

    /**
     * The daemon is shutting down. Stops the run at once, outside the queue, and writes nothing to
     * daemon-state.json: the shutdown deletes that file, and a write after it would bring the file back.
     */
    close(): Promise<void> {
        this.closed = true;
        const current = this.current;
        this.current = null;
        this.generation += 1;
        this.statusValue = { ...this.statusValue, state: DeviceAgentState.Stopped, connectedAt: null };
        return current ? current.run.stop().then(() => undefined) : Promise.resolve();
    }

    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private launch(identity: DeviceIdentity, startedBy: TunnelOrigin): void {
        this.generation += 1;
        const generation = this.generation;
        this.statusValue = {
            state: DeviceAgentState.Connecting,
            deviceAgentId: identity.device_agent_id,
            server: identity.server,
            email: null,
            deviceUrl: null,
            startedAt: this.dependencies.now().toISOString(),
            connectedAt: null,
            startedBy,
            lastError: null,
        };
        const run = this.dependencies.startRun(identity, this.reporterFor(generation));
        this.current = { run, token: identity.token, server: identity.server };
        this.dependencies.recordRunning(startedBy);
        logger.info("Device agent started in the daemon", { startedBy });
        void run.done.then((end) => this.onRunEnded(generation, end));
    }

    private async stopCurrent(): Promise<void> {
        const current = this.current;
        if (!current) {
            return;
        }
        this.current = null;
        this.generation += 1;
        this.statusValue = { ...this.statusValue, state: DeviceAgentState.Stopped, connectedAt: null };
        if (!this.closed) {
            this.dependencies.recordStopped();
        }
        await current.run.stop();
        logger.info("Device agent stopped in the daemon");
    }

    /** The run ended on its own: the dashboard refused the credential or ended the device. */
    private onRunEnded(generation: number, end: DeviceAgentEnd): void {
        if (generation !== this.generation) {
            return;
        }
        this.current = null;
        this.statusValue = {
            ...this.statusValue, state: DeviceAgentState.Stopped, connectedAt: null, lastError: end.error,
        };
        if (!this.closed) {
            this.dependencies.recordStopped();
        }
    }

    /** Logs every event, and keeps the latest for `GET /device`. Never logs the email or a payload. */
    private reporterFor(generation: number): DeviceAgentReporter {
        const isCurrent = () => generation === this.generation;
        let welcomedOnce = false;
        const notConnected = () => (welcomedOnce ? DeviceAgentState.Reconnecting : DeviceAgentState.Connecting);
        return {
            connecting: (server) => {
                if (!isCurrent()) return;
                this.statusValue = { ...this.statusValue, state: notConnected(), connectedAt: null };
                logger.info("Device agent connecting", { server });
            },
            connected: (welcome) => {
                if (!isCurrent()) return;
                welcomedOnce = true;
                this.statusValue = {
                    ...this.statusValue,
                    state: DeviceAgentState.Connected,
                    deviceAgentId: welcome.device_agent_id,
                    email: welcome.email ?? null,
                    deviceUrl: welcome.device_url ?? null,
                    connectedAt: this.dependencies.now().toISOString(),
                };
                logger.info("Device agent connected", { deviceAgentId: welcome.device_agent_id });
            },
            reconnecting: (delayMillis, attempt) => {
                if (!isCurrent()) return;
                this.statusValue = { ...this.statusValue, state: notConnected(), connectedAt: null };
                logger.warn("Device agent disconnected", { delayMillis, attempt });
            },
            warn: (message) => {
                logger.warn("Device agent warning", { message });
            },
            failed: (error) => {
                logger.error("Device agent ended", { code: error.code });
            },
            replacingDevice: (oldDeviceAgentId) => {
                logger.info("Device agent connects a new device in place of a stored one", { oldDeviceAgentId });
            },
        };
    }
}

/**
 * The daemon's run writes device.json on each `welcome`, but only while the file still holds its own
 * token. `connect -b` with a new token writes the new credential, then asks the daemon to switch. An old
 * run that reconnects in that moment must not write the old credential back.
 */
export function writeIdentityWhileOwned(identity: DeviceIdentity): void {
    const stored = readDeviceIdentity();
    if (stored && stored.token !== identity.token) {
        logger.info("Device agent left a newer device.json in place");
        return;
    }
    writeDeviceIdentity(identity);
}

/** The real daemon: device.json, and the daemon's own port for the tunnel list and actions. */
export function machineDeviceAgentHostDependencies(
    port: number,
    record: Pick<DeviceAgentHostDependencies, "recordRunning" | "recordStopped">,
): DeviceAgentHostDependencies {
    return {
        readIdentity: readDeviceIdentity,
        startRun: (identity, reporter) => startDeviceAgent(identity.token, identity.server, {
            reporter,
            tunnelListSource: selfTunnelListSource(port),
            tunnelActions: selfTunnelActionDependencies(port),
            writeIdentity: writeIdentityWhileOwned,
        }),
        recordRunning: record.recordRunning,
        recordStopped: record.recordStopped,
        now: () => new Date(),
    };
}
