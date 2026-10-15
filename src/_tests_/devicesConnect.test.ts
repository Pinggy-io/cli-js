import { describe, test, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';

import {
    DEVICE_AGENT_TOKEN_VARIABLE,
    handleDevices,
    resolveConnectTarget,
    takeEnvironmentToken,
} from '../cli/subcommand/handlers/devicesCommand.js';
import { buildDeviceAgentWsUrl } from '../devices/deviceAgent.js';
import { DeviceIdentity } from '../devices/deviceIdentity.js';
import { redirectConfigHome } from './helpers/fakeDashboard.js';

/**
 * Which token and which server `pinggy devices connect` uses, and that DEVICE_AGENT_TOKEN never outlives
 * the read. The dashboard's install command passes the token in the environment, and every shell the
 * terminal opens copies that environment.
 */

const PRODUCTION_WS_URL = 'wss://dashboard.pinggy.io/backend/api/v1/device-agent/ws/connect';
const TEST_SERVER = 'ws://dashboard.localhost.pinggy.io';
const FLAG_TOKEN = 'pga_from_the_flag';
const ENVIRONMENT_TOKEN = 'pga_from_the_environment';
const STORED_TOKEN = 'pga_from_device_json';

const configHome = redirectConfigHome();

afterAll(() => {
    configHome.cleanup();
});

function storedOnTestServer(): DeviceIdentity {
    return {
        device_agent_id: '11111111-2222-3333-4444-555555555555',
        token: STORED_TOKEN,
        server: TEST_SERVER,
        enrolled_at: '2026-09-15T00:00:00.000Z',
    };
}

describe('the token connect uses', () => {
    test('--token beats the variable', () => {
        const target = resolveConnectTarget(FLAG_TOKEN, ENVIRONMENT_TOKEN, undefined, storedOnTestServer());
        expect(target?.token).toBe(FLAG_TOKEN);
    });

    test('the variable beats device.json', () => {
        const target = resolveConnectTarget(undefined, ENVIRONMENT_TOKEN, undefined, storedOnTestServer());
        expect(target?.token).toBe(ENVIRONMENT_TOKEN);
    });

    test('device.json when neither is given', () => {
        const target = resolveConnectTarget(undefined, undefined, undefined, storedOnTestServer());
        expect(target?.token).toBe(STORED_TOKEN);
    });

    test('no token anywhere gives no target', () => {
        expect(resolveConnectTarget(undefined, undefined, undefined, null)).toBeNull();
    });
});

describe('the server connect dials', () => {
    // The stored server belongs to the stored token. A production token must not go to a test dashboard.
    test('a token from the variable with no --manage dials production, even when device.json names another', () => {
        const target = resolveConnectTarget(undefined, ENVIRONMENT_TOKEN, undefined, storedOnTestServer());
        expect(buildDeviceAgentWsUrl(target?.manage)).toBe(PRODUCTION_WS_URL);
    });

    test('a token from the variable dials --manage when given', () => {
        const target = resolveConnectTarget(undefined, ENVIRONMENT_TOKEN, TEST_SERVER, null);
        expect(target?.manage).toBe(TEST_SERVER);
    });

    test('the stored token dials the stored server', () => {
        const target = resolveConnectTarget(undefined, undefined, undefined, storedOnTestServer());
        expect(target?.manage).toBe(TEST_SERVER);
    });

    test('--token with no --manage dials the stored server, as before', () => {
        const target = resolveConnectTarget(FLAG_TOKEN, undefined, undefined, storedOnTestServer());
        expect(target?.manage).toBe(TEST_SERVER);
    });
});

describe('DEVICE_AGENT_TOKEN', () => {
    let logSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        delete process.env[DEVICE_AGENT_TOKEN_VARIABLE];
    });

    test('is read, then deleted from the environment', () => {
        process.env[DEVICE_AGENT_TOKEN_VARIABLE] = ENVIRONMENT_TOKEN;

        expect(takeEnvironmentToken()).toBe(ENVIRONMENT_TOKEN);
        expect(process.env[DEVICE_AGENT_TOKEN_VARIABLE]).toBeUndefined();
    });

    test('an empty value counts as unset, and is deleted too', () => {
        process.env[DEVICE_AGENT_TOKEN_VARIABLE] = '';

        expect(takeEnvironmentToken()).toBeUndefined();
        expect(DEVICE_AGENT_TOKEN_VARIABLE in process.env).toBe(false);
    });

    // status connects nothing, so the test needs no dashboard. --token wins over the variable here, and the
    // variable must be gone all the same.
    test('is gone from the environment after a devices command, whichever token won', async () => {
        process.env[DEVICE_AGENT_TOKEN_VARIABLE] = ENVIRONMENT_TOKEN;

        await handleDevices(['status', '--token', FLAG_TOKEN]);

        expect(DEVICE_AGENT_TOKEN_VARIABLE in process.env).toBe(false);
    });
});
