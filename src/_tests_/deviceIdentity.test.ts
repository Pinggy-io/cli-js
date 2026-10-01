import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import fs from 'fs';

import {
    DeviceIdentity,
    clearDeviceIdentity,
    maskToken,
    readDeviceIdentity,
    writeDeviceIdentity,
} from '../devices/deviceIdentity.js';
import { getDeviceConfigPath } from '../utils/configDir.js';
import { redirectConfigHome } from './helpers/fakeDashboard.js';

/**
 * device.json holds a live credential, so its mode is not a detail.
 *
 * The file beside it, written by configStore.ts for saved tunnel configs, lands at 0644 under a
 * normal umask. This one must not.
 */

// POSIX modes only. Windows reports something else entirely and nothing here would mean anything.
const canAssertMode = process.platform !== 'win32';
const SECRET_MODE = 0o600;

const configHome = redirectConfigHome();

afterAll(() => {
    configHome.cleanup();
});

function identity(): DeviceIdentity {
    return {
        device_agent_id: '11111111-2222-3333-4444-555555555555',
        token: 'pdat_abcdefghijklmnopqrstuvwxyz',
        server: 'dashboard.pinggy.io',
        enrolled_at: '2026-09-15T00:00:00.000Z',
    };
}

function modeOf(filePath: string): number {
    return fs.statSync(filePath).mode & 0o777;
}

describe('device identity file', () => {
    beforeEach(() => {
        const filePath = getDeviceConfigPath();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

    test('a round trip returns what was written', () => {
        writeDeviceIdentity(identity());
        expect(readDeviceIdentity()).toEqual(identity());
    });

    (canAssertMode ? test : test.skip)('a new file is created 0600', () => {
        writeDeviceIdentity(identity());
        expect(modeOf(getDeviceConfigPath())).toBe(SECRET_MODE);
    });

    /**
     * The case the slice calls out as the likely miss. writeFileSync honours `mode` only when it
     * creates the file, so a rewrite keeps whatever mode the file already had. A device.json
     * written by an older build would stay world-readable forever without the explicit chmod.
     */
    (canAssertMode ? test : test.skip)('a rewrite tightens a file that was already world-readable', () => {
        const filePath = getDeviceConfigPath();
        fs.writeFileSync(filePath, '{}', { mode: 0o644 });
        fs.chmodSync(filePath, 0o644);
        expect(modeOf(filePath)).toBe(0o644);

        writeDeviceIdentity(identity());

        expect(modeOf(filePath)).toBe(SECRET_MODE);
        expect(readDeviceIdentity()).toEqual(identity());
    });

    (canAssertMode ? test : test.skip)('rewriting an existing 0600 file leaves it 0600', () => {
        writeDeviceIdentity(identity());
        writeDeviceIdentity({ ...identity(), token: 'pdat_rotated' });

        expect(modeOf(getDeviceConfigPath())).toBe(SECRET_MODE);
        expect(readDeviceIdentity()?.token).toBe('pdat_rotated');
    });

    test('a missing file reads as null rather than throwing', () => {
        expect(readDeviceIdentity()).toBeNull();
    });

    // A half-written file must not stop the agent starting. It re-enrols instead.
    test('an unreadable file reads as null rather than throwing', () => {
        fs.writeFileSync(getDeviceConfigPath(), '{ not json');
        expect(readDeviceIdentity()).toBeNull();
    });

    test('clearing reports whether there was anything to clear', () => {
        expect(clearDeviceIdentity()).toBe(false);

        writeDeviceIdentity(identity());
        expect(clearDeviceIdentity()).toBe(true);
        expect(fs.existsSync(getDeviceConfigPath())).toBe(false);
    });
});

describe('token masking', () => {
    test('a real token never prints in full', () => {
        const token = 'pdat_abcdefghijklmnopqrstuvwxyz';
        const masked = maskToken(token);

        expect(masked).not.toBe(token);
        expect(masked).not.toContain('klmnopqrst');
        expect(masked.startsWith('pdat_abc')).toBe(true);
    });

    test('a short value is hidden entirely, since a prefix would be most of it', () => {
        expect(maskToken('short')).toBe('***');
    });
});
