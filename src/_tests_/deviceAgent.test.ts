import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvelope, request, event, PROTOCOL_VERSION, CHANNEL_SYSTEM, OP_HELLO } from '../devices/envelope.js';
import { WelcomeSchema } from '../devices/device_schema.js';
import { buildDeviceAgentWsUrl } from '../devices/deviceAgent.js';

describe('device agent envelope', () => {
    test('request carries the protocol version, a correlation id and a timestamp', () => {
        const frame = request(CHANNEL_SYSTEM, OP_HELLO, { os: 'linux' });
        expect(frame.v).toBe(PROTOCOL_VERSION);
        expect(frame.kind).toBe('req');
        expect(frame.id).not.toHaveLength(0);
        expect(frame.ts).toBeGreaterThan(0);
    });

    test('an event carries an empty id, because nothing answers it', () => {
        expect(event(CHANNEL_SYSTEM, 'heartbeat', {}).id).toBe('');
    });

    // Unparseable input must never throw: a frame this build does not understand cannot be allowed
    // to drop the connection, or the protocol stops being forward compatible.
    test.each([
        ['not json at all'],
        ['null'],
        ['[]'],
        ['{"ch":"system"}'],
        ['{"op":"hello"}'],
    ])('parseEnvelope returns null rather than throwing for %s', (raw) => {
        expect(parseEnvelope(raw)).toBeNull();
    });

    test('parseEnvelope keeps a frame whose channel this build has never heard of', () => {
        const parsed = parseEnvelope('{"v":1,"kind":"req","ch":"terminal","op":"open","id":"x","seq":0,"ts":1,"payload":{}}');
        expect(parsed?.ch).toBe('terminal');
    });
});

describe('welcome schema', () => {
    const welcome = {
        device_agent_id: '0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d',
        accepted_proto: 1,
        heartbeat_interval_seconds: 30,
        stats_interval_seconds: 60,
        server_time: 1750000001,
        max_frame_bytes: 32768,
    };

    test('parses a welcome', () => {
        expect(WelcomeSchema.safeParse(welcome).success).toBe(true);
    });

    // The dashboard must be able to add fields to welcome without breaking an older agent.
    test('ignores fields a newer dashboard added', () => {
        const result = WelcomeSchema.safeParse({ ...welcome, terminal_window_bytes: 1048576, future: true });
        expect(result.success).toBe(true);
        expect(result.success && 'future' in result.data).toBe(false);
    });
});

describe('ws url', () => {
    test('defaults to wss and the dashboard host', () => {
        expect(buildDeviceAgentWsUrl()).toBe('wss://dashboard.pinggy.io/backend/api/v1/device-agent/ws/connect');
    });

    test('honours an explicit ws:// prefix, which local development needs', () => {
        expect(buildDeviceAgentWsUrl('ws://dashboard.localhost.pinggy.io'))
            .toBe('ws://dashboard.localhost.pinggy.io/backend/api/v1/device-agent/ws/connect');
    });

    test('strips a trailing slash', () => {
        expect(buildDeviceAgentWsUrl('example.com/')).toBe('wss://example.com/backend/api/v1/device-agent/ws/connect');
    });
});

describe('device identity file', () => {
    let tempHome: string;
    const originalXdg = process.env.XDG_CONFIG_HOME;

    beforeEach(() => {
        tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-devices-'));
        process.env.XDG_CONFIG_HOME = tempHome;
        jest.resetModules();
    });

    afterEach(() => {
        if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalXdg;
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    // The file holds a live credential. configStore.ts writes tunnel configs with no mode and lands
    // them at 0644; this must not copy that.
    test('is written 0600, and stays 0600 when rewritten', async () => {
        const { writeDeviceIdentity, readDeviceIdentity } = await import('../devices/deviceIdentity.js');
        const identity = { device_agent_id: null, token: 'pga_abc', server: 'x', enrolled_at: null };

        writeDeviceIdentity(identity);
        const filePath = path.join(tempHome, 'pinggy', 'device.json');
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

        fs.chmodSync(filePath, 0o644);
        writeDeviceIdentity({ ...identity, device_agent_id: 'abc' });
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        expect(readDeviceIdentity()?.device_agent_id).toBe('abc');
    });
});
