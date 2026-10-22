import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
    ManagedTunnel, TunnelAlreadyRunningError, TunnelManager, TunnelRebuildInProgressError,
} from "../tunnel_manager/TunnelManager.js";
import { TunnelOperations } from "../remote_management/handler.js";
import { ErrorCode, isErrorResponse, TunnelStateType } from "../types.js";

const TUNNEL_ID = "tunnel-1";
const CONFIG_ID = "config-1";
const TUNNEL_CONFIG = { configId: CONFIG_ID, name: "web", forwarding: "localhost:3000", token: "token" };
const PUBLIC_URL = "https://example.a.pinggy.link";
const REBUILD_FAILURE = "worker did not start";

function fakeInstance() {
    return {
        start: jest.fn(async () => [PUBLIC_URL]),
        stop: jest.fn(async () => undefined),
        getStatus: jest.fn(async () => TunnelStateType.Live),
        getConfig: jest.fn(async () => TUNNEL_CONFIG),
        urls: jest.fn(async () => [PUBLIC_URL]),
        getGreetMessage: jest.fn(async () => null),
        getLocalServerTls: jest.fn(async () => false),
    };
}

function managedTunnel(isStopped: boolean): ManagedTunnel {
    return {
        tunnelid: TUNNEL_ID,
        configId: CONFIG_ID,
        tunnelName: "web",
        origin: "device",
        instance: fakeInstance(),
        tunnelConfig: TUNNEL_CONFIG,
        isStopped,
        createdAt: "2026-10-01T00:00:00.000Z",
        startedAt: null,
        stoppedAt: null,
        lastError: {},
    } as unknown as ManagedTunnel;
}

/** Puts `managed` into both private maps, the way `_createTunnelWithProcessedConfig` does. */
function addTunnel(tunnelManager: TunnelManager, managed: ManagedTunnel): void {
    // @ts-ignore - private map
    tunnelManager.tunnelsByTunnelId.set(managed.tunnelid, managed);
    // @ts-ignore - private map
    tunnelManager.tunnelsByConfigId.set(managed.configId, managed);
}

function listedEntry(tunnelManager: TunnelManager): ManagedTunnel | undefined {
    // @ts-ignore - private map
    return tunnelManager.tunnelsByTunnelId.get(TUNNEL_ID);
}

/**
 * Holds the rebuild open where the old code left the maps empty: `_createTunnelWithProcessedConfig`
 * answers only when the test calls `finish` or `fail`.
 */
function holdRebuild(tunnelManager: TunnelManager) {
    const replacement = managedTunnel(false);
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const created = new Promise<ManagedTunnel>((resolve, reject) => {
        finish = () => {
            addTunnel(tunnelManager, replacement);
            resolve(replacement);
        };
        fail = reject;
    });
    const internals = tunnelManager as unknown as { _createTunnelWithProcessedConfig: () => Promise<ManagedTunnel> };
    jest.spyOn(internals, "_createTunnelWithProcessedConfig").mockImplementation(() => created);
    return { replacement, finish, fail };
}

/** Lets the rebuild run up to the create it waits on. */
function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('a tunnel being rebuilt', () => {
    let tunnelManager: TunnelManager;

    beforeEach(() => {
        // @ts-ignore - reset the singleton
        TunnelManager.instance = undefined;
        tunnelManager = TunnelManager.getInstance();
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    describe('by restart', () => {
        test('a stopped tunnel stays listed as starting until the new entry replaces it', async () => {
            addTunnel(tunnelManager, managedTunnel(true));
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();

            expect((await tunnelManager.getAllTunnels()).map((tunnel) => tunnel.tunnelid)).toEqual([TUNNEL_ID]);
            expect(await tunnelManager.getTunnelStatus(TUNNEL_ID)).toBe(TunnelStateType.Starting);

            rebuild.finish();
            await restarted;

            expect(listedEntry(tunnelManager)).toBe(rebuild.replacement);
            expect(rebuild.replacement.rebuild).toBeUndefined();
        });

        test('a running tunnel is stopped first and stays listed as starting', async () => {
            const running = managedTunnel(false);
            addTunnel(tunnelManager, running);
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();

            expect(running.instance.stop).toHaveBeenCalled();
            expect(running.isStopped).toBe(true);
            expect(listedEntry(tunnelManager)).toBe(running);
            expect(await tunnelManager.getTunnelStatus(TUNNEL_ID)).toBe(TunnelStateType.Starting);

            rebuild.finish();
            await restarted;
        });

        test('GET /tunnels lists it as starting, from the stored config, not the stopped instance', async () => {
            const stopped = managedTunnel(true);
            stopped.lastError = { message: "an earlier failure", timestamp: "", isFatal: true };
            addTunnel(tunnelManager, stopped);
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();
            const listed = await new TunnelOperations().handleListV2();

            expect(isErrorResponse(listed)).toBe(false);
            if (isErrorResponse(listed)) return;
            expect(listed).toHaveLength(1);
            expect(listed[0].tunnelid).toBe(TUNNEL_ID);
            expect(listed[0].status.state).toBe(TunnelStateType.Starting);
            expect(listed[0].status.errormsg).toBe("");
            expect(listed[0].remoteurls).toEqual([]);
            expect(stopped.instance.getConfig).not.toHaveBeenCalled();

            rebuild.finish();
            await restarted;
        });

        test('a failed rebuild leaves the old entry listed as exited, with the reason', async () => {
            const stopped = managedTunnel(true);
            addTunnel(tunnelManager, stopped);
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();
            rebuild.fail(new Error(REBUILD_FAILURE));

            await expect(restarted).rejects.toThrow(REBUILD_FAILURE);
            expect(listedEntry(tunnelManager)).toBe(stopped);
            expect(stopped.rebuild).toBeUndefined();
            expect(await tunnelManager.getTunnelStatus(TUNNEL_ID)).toBe(TunnelStateType.Exited);
            expect(stopped.lastError.isFatal).toBe(true);
            expect(stopped.lastError.message).toBe(REBUILD_FAILURE);
        });

        test('a 2nd restart is refused, and the no-wait route answers an error, not starting', async () => {
            addTunnel(tunnelManager, managedTunnel(true));
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();

            await expect(tunnelManager.restartTunnel(TUNNEL_ID)).rejects.toThrow(TunnelRebuildInProgressError);
            const answer = await new TunnelOperations().handleRestart(TUNNEL_ID, true);
            expect(isErrorResponse(answer) && answer.code).toBe(ErrorCode.TunnelAlreadyRunningError);

            rebuild.finish();
            await restarted;
        });

        test('a start of the same config is refused', async () => {
            addTunnel(tunnelManager, managedTunnel(true));
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();

            await expect(tunnelManager.createTunnel({ ...TUNNEL_CONFIG } as never))
                .rejects.toThrow(TunnelAlreadyRunningError);

            rebuild.finish();
            await restarted;
        });

        test('remove-stopped leaves it in the list', async () => {
            const stopped = managedTunnel(true);
            addTunnel(tunnelManager, stopped);
            const rebuild = holdRebuild(tunnelManager);

            const restarted = tunnelManager.restartTunnel(TUNNEL_ID);
            await settle();

            expect(tunnelManager.removeStoppedTunnelByTunnelId(TUNNEL_ID)).toBe(false);
            expect(listedEntry(tunnelManager)).toBe(stopped);

            rebuild.finish();
            await restarted;
        });
    });

    describe('by config update', () => {
        test('a running tunnel stays listed as starting until the new entry replaces it', async () => {
            addTunnel(tunnelManager, managedTunnel(false));
            const rebuild = holdRebuild(tunnelManager);

            const updated = tunnelManager.updateConfig({ ...TUNNEL_CONFIG } as never);
            await settle();

            expect((await tunnelManager.getAllTunnels()).map((tunnel) => tunnel.tunnelid)).toEqual([TUNNEL_ID]);
            expect(await tunnelManager.getTunnelStatus(TUNNEL_ID)).toBe(TunnelStateType.Starting);

            rebuild.finish();
            await updated;
            expect(listedEntry(tunnelManager)).toBe(rebuild.replacement);
        });

        test('a stopped tunnel stays listed as exited, since the update does not start it', async () => {
            addTunnel(tunnelManager, managedTunnel(true));
            const rebuild = holdRebuild(tunnelManager);

            const updated = tunnelManager.updateConfig({ ...TUNNEL_CONFIG } as never);
            await settle();

            expect(await tunnelManager.getTunnelStatus(TUNNEL_ID)).toBe(TunnelStateType.Exited);

            rebuild.finish();
            await updated;
        });

        test('a failed update whose restore also fails leaves the old entry exited, with the reason', async () => {
            const running = managedTunnel(false);
            addTunnel(tunnelManager, running);
            const rebuild = holdRebuild(tunnelManager);

            const updated = tunnelManager.updateConfig({ ...TUNNEL_CONFIG } as never);
            await settle();
            rebuild.fail(new Error(REBUILD_FAILURE));

            await expect(updated).rejects.toThrow(REBUILD_FAILURE);
            expect(listedEntry(tunnelManager)).toBe(running);
            expect(running.rebuild).toBeUndefined();
            expect(await tunnelManager.getTunnelStatus(TUNNEL_ID)).toBe(TunnelStateType.Exited);
            expect(running.lastError.message).toBe(REBUILD_FAILURE);
        });
    });
});
