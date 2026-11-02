import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { IPCServer } from '../daemon/ipc/ipcServer.js';
import { IPCClient } from '../daemon/ipc/ipcClient.js';
import { DeviceAgentState } from '../daemon/ipc/ipcRoutes.js';
import { DeviceAgentHost } from '../daemon/deviceAgentHost.js';
import { DeviceAgentEnd } from '../devices/deviceAgent.js';
import { DeviceIdentity } from '../devices/deviceIdentity.js';
import { DaemonState, loadDaemonState, persistDaemonState } from '../daemon/lifecycle/stateStore.js';
import { getPinggyConfigDir } from '../utils/configDir.js';
import { redirectConfigHome } from './helpers/fakeDashboard.js';

/**
 * The 3 device routes on a real IPC server, and the daemon-state.json field that brings the agent back
 * after a crash. Any local user can reach the IPC port, so no route may take a token or a server.
 */

const STORED_TOKEN = 'pga_token_from_device_json';
const BODY_TOKEN = 'pga_token_another_user_sent';

const STORED: DeviceIdentity = {
    device_agent_id: 'device-a', token: STORED_TOKEN, server: 'dashboard.pinggy.io', enrolled_at: null,
};

/** A run that ends when stopped. */
function idleRun() {
    let end!: (value: DeviceAgentEnd) => void;
    const done = new Promise<DeviceAgentEnd>((resolve) => { end = resolve; });
    return {
        done,
        stop: () => {
            end({ error: null, welcomed: false });
            return done;
        },
    };
}

/** POSTs a raw body, the way any local process can. */
function post(port: number, routePath: string, body: string): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1', port, path: routePath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Pinggy-Origin': 'app' },
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }));
        });
        request.on('error', reject);
        request.end(body);
    });
}

describe('the device routes', () => {
    const dialled: Array<{ token: string; server: string }> = [];
    const recorded: string[] = [];
    let server: IPCServer;
    let port: number;

    beforeAll(async () => {
        server = new IPCServer();
        server.setDeviceAgentHost(new DeviceAgentHost({
            readIdentity: () => STORED,
            startRun: (identity) => {
                dialled.push({ token: identity.token, server: identity.server });
                return idleRun();
            },
            recordRunning: (startedBy) => { recorded.push(`running ${startedBy}`); },
            recordStopped: () => { recorded.push('stopped'); },
            now: () => new Date('2026-10-15T10:00:00.000Z'),
        }));
        port = await server.listen();
    });

    afterAll(async () => {
        await server.close();
    });

    test('start ignores a token and a server in the body, and dials what device.json holds', async () => {
        const answer = await post(port, '/device/start',
            JSON.stringify({ token: BODY_TOKEN, manage: 'evil.example.com' }));

        expect(answer.status).toBe(200);
        expect(dialled).toEqual([{ token: STORED_TOKEN, server: 'dashboard.pinggy.io' }]);
        expect(recorded).toEqual(['running app']);
        expect(JSON.stringify(answer.json)).not.toContain(STORED_TOKEN);
    });

    test('status reports the run, with the origin that started it and no token', async () => {
        const status = await new IPCClient(port).getDeviceAgentStatus();

        expect(status).toMatchObject({
            state: DeviceAgentState.Connecting, startedBy: 'app', deviceAgentId: 'device-a',
        });
        expect(JSON.stringify(status)).not.toContain(STORED_TOKEN);
    });

    test('stop ends the run', async () => {
        const status = await new IPCClient(port).stopDeviceAgent();

        expect(status.state).toBe(DeviceAgentState.Stopped);
        expect(recorded.at(-1)).toBe('stopped');
    });
});

describe('daemon-state.json', () => {
    let configHome: { cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    test('keeps the device agent across a write and a read', () => {
        const state: DaemonState = {
            tunnels: [], deviceAgent: { startedAt: '2026-10-15T10:00:00.000Z', startedBy: 'cli' }, lastUpdated: '',
        };

        persistDaemonState(state);

        expect(loadDaemonState()?.deviceAgent).toEqual({ startedAt: '2026-10-15T10:00:00.000Z', startedBy: 'cli' });
    });

    test('a file written before slice 17 still loads, with no device agent', () => {
        fs.mkdirSync(getPinggyConfigDir(), { recursive: true });
        fs.writeFileSync(path.join(getPinggyConfigDir(), 'daemon-state.json'),
            JSON.stringify({ tunnels: [], lastUpdated: '2026-10-01T00:00:00.000Z' }));

        const state = loadDaemonState();

        expect(state?.tunnels).toEqual([]);
        expect(state?.deviceAgent).toBeUndefined();
    });
});
