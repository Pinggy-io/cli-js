import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvelope, request, event, PROTOCOL_VERSION, CHANNEL_SYSTEM, OP_HELLO } from '../devices/envelope.js';
import { WelcomeSchema } from '../devices/device_schema.js';
import {
    AGENT_ERROR_NOT_CONNECTED, AGENT_ERROR_UNAUTHORIZED, buildDeviceAgentWsUrl, printConnected, runDeviceAgent,
    startDeviceAgent,
} from '../devices/deviceAgent.js';
import { DeviceAgentReporter } from '../devices/deviceAgentReporter.js';
import CLIPrinter from '../utils/printer.js';
import { readDeviceIdentity, writeDeviceIdentity } from '../devices/deviceIdentity.js';
import { ReconnectPolicy } from '../devices/reconnect.js';
import {
    FAKE_DEVICE_AGENT_ID,
    disconnectFrame,
    plain,
    redirectConfigHome,
    startFakeDashboard,
    startRefusingDashboard,
    welcomeFrame,
} from './helpers/fakeDashboard.js';

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

    test('keeps the owner email and the device page', () => {
        const result = WelcomeSchema.safeParse({
            ...welcome, email: 'owner@example.com', device_url: 'https://dashboard.pinggy.io/pinggy-devices/0a7d',
        });
        expect(result.success && result.data.email).toBe('owner@example.com');
        expect(result.success && result.data.device_url).toBe('https://dashboard.pinggy.io/pinggy-devices/0a7d');
    });
});

describe('printConnected', () => {
    const welcome = WelcomeSchema.parse({
        device_agent_id: '0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d',
        accepted_proto: 1,
        heartbeat_interval_seconds: 30,
        stats_interval_seconds: 60,
        server_time: 1750000001,
        max_frame_bytes: 32768,
    });
    let printed: string[];

    beforeEach(() => {
        printed = [];
        jest.spyOn(CLIPrinter, 'success').mockImplementation((message: string) => { printed.push(message); });
        jest.spyOn(CLIPrinter, 'print').mockImplementation((message: string) => { printed.push(message); });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('prints the email and the device link when welcome carries them', () => {
        printConnected({ ...welcome, email: 'owner@example.com', device_url: 'https://dashboard.pinggy.io/pinggy-devices/0a7d' });
        expect(printed).toEqual([
            'Connected as device 0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d',
            'Signed in as owner@example.com',
            'Open the device in a browser:',
            '  https://dashboard.pinggy.io/pinggy-devices/0a7d',
        ]);
    });

    // An older dashboard sends neither field.
    test('prints only the device id when welcome carries neither', () => {
        printConnected(welcome);
        expect(printed).toEqual(['Connected as device 0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d']);
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

/**
 * A token pasted from the dashboard is another device when it differs from the stored one. Carrying the
 * old device_agent_id or enrolled_at over would describe a device this token is not.
 */
describe('the identity a run writes on welcome', () => {
    const OLD_DEVICE_AGENT_ID = '99999999-8888-7777-6666-555555555555';
    const OLD_ENROLLED_AT = '2026-01-01T00:00:00.000Z';

    let configHome: { cleanup: () => void };
    let printed: string[];
    let logSpy: ReturnType<typeof jest.spyOn>;
    let warnSpy: ReturnType<typeof jest.spyOn>;
    let errorSpy: ReturnType<typeof jest.spyOn>;

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    beforeEach(() => {
        printed = [];
        const capture = (...args: unknown[]) => { printed.push(plain(args.map(String).join(' '))); };
        logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(capture);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(capture);
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    /** Welcome, then revoked, so the loop writes device.json once and returns. */
    async function runUntilWelcomed(token: string): Promise<void> {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(welcomeFrame());
                connection.send(disconnectFrame('revoked'));
            },
        });
        await runDeviceAgent(token, dashboard.url, { reconnectPolicy: new ReconnectPolicy({ random: () => 0 }) });
        dashboard.close();
    }

    test('a token that differs from the stored one writes a new device_agent_id and a new enrolled_at', async () => {
        writeDeviceIdentity({
            device_agent_id: OLD_DEVICE_AGENT_ID, token: 'pga_old', server: 'x', enrolled_at: OLD_ENROLLED_AT,
        });

        await runUntilWelcomed('pga_new');

        const written = readDeviceIdentity();
        expect(written?.token).toBe('pga_new');
        expect(written?.device_agent_id).toBe(FAKE_DEVICE_AGENT_ID);
        expect(written?.enrolled_at).not.toBeNull();
        expect(written?.enrolled_at).not.toBe(OLD_ENROLLED_AT);
        expect(printed.join(' ')).toContain(`This machine was device ${OLD_DEVICE_AGENT_ID}.`);
    }, 15000);

    test('the same token keeps the old enrolled_at', async () => {
        writeDeviceIdentity({
            device_agent_id: FAKE_DEVICE_AGENT_ID, token: 'pga_same', server: 'x', enrolled_at: OLD_ENROLLED_AT,
        });

        await runUntilWelcomed('pga_same');

        expect(readDeviceIdentity()?.enrolled_at).toBe(OLD_ENROLLED_AT);
        expect(printed.join(' ')).not.toContain('This machine was device');
    }, 15000);
});

/**
 * A run the daemon hosts (`pinggy devices connect -b`) has no Ctrl+C. `stop()` is how it ends, and it must
 * end at once: during the backoff, and on a live socket.
 */
describe('stopping a run', () => {
    let configHome: { cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    /** Records nothing. Each test waits on the 1 event it needs. */
    function reporterWaitingFor(eventName: keyof DeviceAgentReporter) {
        let reached!: () => void;
        const happened = new Promise<void>((resolve) => { reached = resolve; });
        const reporter: DeviceAgentReporter = {
            connecting: () => undefined,
            connected: () => undefined,
            reconnecting: () => undefined,
            warn: () => undefined,
            failed: () => undefined,
            replacingDevice: () => undefined,
            [eventName]: () => reached(),
        };
        return { reporter, happened };
    }

    test('during the backoff sleep returns at once', async () => {
        const dashboard = await startFakeDashboard({ onHello: (connection) => connection.drop() });
        const policy = new ReconnectPolicy({ random: () => 0 });
        jest.spyOn(policy, 'nextDelayMillis').mockReturnValue(60_000);
        const { reporter, happened } = reporterWaitingFor('reconnecting');

        const run = startDeviceAgent('token', dashboard.url, { reconnectPolicy: policy, reporter });
        await happened;
        const stoppedAt = Date.now();
        const end = await run.stop();

        expect(Date.now() - stoppedAt).toBeLessThan(1000);
        expect(end).toEqual({ error: null, welcomed: false });
        dashboard.close();
    }, 15000);

    test('on a live socket closes it with 1000', async () => {
        let closeCode!: (code: number) => void;
        const closed = new Promise<number>((resolve) => { closeCode = resolve; });
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.socket.on('close', (code) => closeCode(code));
                connection.send(welcomeFrame(60));
            },
        });
        const { reporter, happened } = reporterWaitingFor('connected');

        const run = startDeviceAgent('token', dashboard.url, { reporter });
        await happened;
        const end = await run.stop();

        expect(await closed).toBe(1000);
        expect(end).toEqual({ error: null, welcomed: true });
        dashboard.close();
    }, 15000);
});

/** `connect -b` checks a new token with 1 handshake before the daemon dials with it. */
describe('a verify run', () => {
    let configHome: { cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    const silent: DeviceAgentReporter = {
        connecting: () => undefined,
        connected: () => undefined,
        reconnecting: () => undefined,
        warn: () => undefined,
        failed: () => undefined,
        replacingDevice: () => undefined,
    };

    test('ends at welcome, writes device.json, and sends nothing after hello', async () => {
        const framesAfterHello: unknown[] = [];
        const dashboard = await startFakeDashboard({
            onHello: (connection) => connection.send(welcomeFrame()),
            onFrame: (_connection, frame) => framesAfterHello.push(frame),
        });

        const end = await startDeviceAgent('pga_verified', dashboard.url, { verifyOnly: true, reporter: silent }).done;

        expect(end).toEqual({ error: null, welcomed: true });
        expect(readDeviceIdentity()?.token).toBe('pga_verified');
        expect(framesAfterHello).toEqual([]);
        dashboard.close();
    }, 15000);

    test('a refused token ends with unauthorized and leaves device.json alone', async () => {
        writeDeviceIdentity({ device_agent_id: 'kept', token: 'pga_kept', server: 'x', enrolled_at: null });
        const dashboard = await startRefusingDashboard(401);

        const end = await startDeviceAgent('pga_refused', dashboard.url, { verifyOnly: true, reporter: silent }).done;

        expect(end.error?.code).toBe(AGENT_ERROR_UNAUTHORIZED);
        expect(readDeviceIdentity()?.token).toBe('pga_kept');
        dashboard.close();
    }, 15000);

    test('makes 1 attempt only, and ends with not_connected when it fails', async () => {
        const dashboard = await startFakeDashboard({ onHello: (connection) => connection.drop() });

        const end = await startDeviceAgent('token', dashboard.url, { verifyOnly: true, reporter: silent }).done;

        expect(end.error?.code).toBe(AGENT_ERROR_NOT_CONNECTED);
        expect(dashboard.connections()).toBe(1);
        dashboard.close();
    }, 15000);
});
