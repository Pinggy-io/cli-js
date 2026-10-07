import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { ManagedTunnel, TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { TunnelOperations } from "../remote_management/handler.js";
import { TunnelErrorCodeType, TunnelStateType } from "../types.js";

const TUNNEL_ID = "tunnel-1";
const SDK_REASON = "Tunnel disconnected before establishment";

function addTunnel(tunnelManager: TunnelManager, startRejection: unknown): ManagedTunnel {
    const managed = {
        tunnelid: TUNNEL_ID,
        configId: "config-1",
        instance: { start: () => Promise.reject(startRejection) },
        isStopped: false,
        lastError: {},
    } as unknown as ManagedTunnel;
    // @ts-ignore - private map, the same way createTunnel fills it
    tunnelManager.tunnelsByTunnelId.set(TUNNEL_ID, managed);
    return managed;
}

function buildStatus(state: TunnelStateType) {
    // @ts-ignore - private, the status every list and start response carries
    return new TunnelOperations().buildStatus(TUNNEL_ID, state, TunnelErrorCodeType.NoError);
}

describe('a failed tunnel start', () => {
    let tunnelManager: TunnelManager;

    beforeEach(() => {
        // @ts-ignore - reset the singleton
        TunnelManager.instance = undefined;
        tunnelManager = TunnelManager.getInstance();
        jest.clearAllMocks();
    });

    test('keeps the SDK reason in lastError', async () => {
        const managed = addTunnel(tunnelManager, new Error(SDK_REASON));

        await expect(tunnelManager.startTunnel(TUNNEL_ID)).rejects.toThrow(SDK_REASON);

        expect(managed.isStopped).toBe(true);
        expect(managed.lastError.message).toBe(SDK_REASON);
        expect(managed.lastError.isFatal).toBe(true);
    });

    test('falls back to a generic message when the SDK gives none', async () => {
        const managed = addTunnel(tunnelManager, new Error(""));

        await expect(tunnelManager.startTunnel(TUNNEL_ID)).rejects.toThrow();

        expect(managed.lastError.message).toBe("Failed to start tunnel");
    });

    test('reports the reason as the status errormsg', async () => {
        addTunnel(tunnelManager, new Error(SDK_REASON));
        await expect(tunnelManager.startTunnel(TUNNEL_ID)).rejects.toThrow();

        expect(buildStatus(TunnelStateType.Exited).errormsg).toBe(SDK_REASON);
    });

    test('leaves errormsg empty for a non-fatal error', () => {
        const managed = addTunnel(tunnelManager, null);
        managed.lastError = { message: "a recoverable error", timestamp: "", isFatal: false };

        const status = buildStatus(TunnelStateType.Live);

        expect(status.errormsg).toBe("");
        expect(status.lastError?.message).toBe("a recoverable error");
    });
});
