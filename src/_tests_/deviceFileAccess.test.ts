import { describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_ACCESS_OFF, ERROR_FILE_MANAGER_DISABLED, FileError, OP_LIST, OP_MKDIR,
} from '../devices/files/file_schema.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import {
    FILE_ACCESS_QUESTION, FileAccessDependencies, fileAccessAllowed, parseFilesFlag, settleFileAccess,
} from '../devices/fileAccess.js';
import {
    DeviceIdentity, clearDeviceIdentity, readDeviceIdentity, writeDeviceIdentity,
} from '../devices/deviceIdentity.js';
import { redirectConfigHome } from './helpers/fakeDashboard.js';

/**
 * The person on the device decides whether the dashboard's file manager reaches it. device.json holds the answer,
 * and the agent reads it on every file request.
 */

const MAX_FRAME_BYTES = 32768;
const TOKEN = 'pga_file_access_token';

const configHome = redirectConfigHome();

afterAll(() => {
    configHome.cleanup();
});

function identity(extra: Partial<DeviceIdentity> = {}): DeviceIdentity {
    return {
        device_agent_id: '11111111-2222-3333-4444-555555555555', token: TOKEN, server: 'dashboard.pinggy.io',
        enrolled_at: null, ...extra,
    };
}

function fakeFileAccess(options: { interactive?: boolean; answer?: string } = {}) {
    const asked: string[] = [];
    const written: DeviceIdentity[] = [];
    const printed: string[] = [];
    const ask = async (question: string) => {
        asked.push(question);
        return options.answer ?? '';
    };
    const dependencies: FileAccessDependencies = {
        prompter: { ask, askHidden: ask },
        isInteractive: () => options.interactive ?? true,
        writeIdentity: (identityWritten) => { written.push(identityWritten); },
        print: (message) => { printed.push(message); },
    };
    return { dependencies, asked, written, printed };
}

describe('--files', () => {
    test.each([
        ['on', true],
        ['off', false],
        [' OFF ', false],
        ['yes', null],
        ['', null],
    ])('%j parses as %s', (value, parsed) => {
        expect(parseFilesFlag(value)).toBe(parsed);
    });

    test('absent parses as undefined', () => {
        expect(parseFilesFlag(undefined)).toBeUndefined();
    });
});

describe('the question', () => {
    test.each([
        ['', true],
        ['y', true],
        ['yes', true],
        ['n', false],
        ['No', false],
        ['  nope', false],
    ])('the answer %j means %s', async (answer, allowed) => {
        const fake = fakeFileAccess({ answer });

        expect(await settleFileAccess(undefined, TOKEN, identity(), fake.dependencies)).toBe(allowed);

        expect(fake.asked).toEqual([FILE_ACCESS_QUESTION]);
        expect(fake.written).toEqual([identity({ file_manager: allowed })]);
    });

    test('a token device.json does not hold is asked about, and nothing is written yet', async () => {
        const fake = fakeFileAccess({ answer: 'n' });

        expect(await settleFileAccess(undefined, 'pga_another_token', identity({ file_manager: true }),
            fake.dependencies)).toBe(false);

        expect(fake.written).toEqual([]);
    });
});

describe('device.json', () => {
    beforeEach(() => {
        clearDeviceIdentity();
    });

    test('a write with no answer keeps the answer stored for the same token', () => {
        writeDeviceIdentity(identity({ file_manager: false }));

        writeDeviceIdentity(identity({ enrolled_at: '2026-11-23T10:00:00.000Z' }));

        expect(readDeviceIdentity())
            .toEqual(identity({ enrolled_at: '2026-11-23T10:00:00.000Z', file_manager: false }));
    });

    test('a new token starts with no answer', () => {
        writeDeviceIdentity(identity({ file_manager: false }));

        writeDeviceIdentity(identity({ token: 'pga_another_token' }));

        expect(readDeviceIdentity()?.file_manager).toBeUndefined();
    });

    test('a write with an answer replaces the stored one', () => {
        writeDeviceIdentity(identity({ file_manager: false }));

        writeDeviceIdentity(identity({ file_manager: true }));

        expect(readDeviceIdentity()?.file_manager).toBe(true);
    });

    test.each([
        ['no device.json', null, true],
        ['no answer', identity(), true],
        ['yes', identity({ file_manager: true }), true],
        ['no', identity({ file_manager: false }), false],
    ])('with %s, file access is allowed: %s', (_label, stored, allowed) => {
        if (stored) writeDeviceIdentity(stored);

        expect(fileAccessAllowed()).toBe(allowed);
    });
});

describe('the file channel handler', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-access-'));
    });

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    function recordingHandler(allowed: { value: boolean }) {
        const sent: Envelope[] = [];
        const handler = new FileHandler({ send: (frame) => sent.push(frame), fileAccessAllowed: () => allowed.value });
        handler.configure(true, MAX_FRAME_BYTES);
        return { handler, sent };
    }

    test('refuses every request with file_access_off while the answer is no, and runs none', async () => {
        const { handler, sent } = recordingHandler({ value: false });

        await handler.handle(request(CHANNEL_FILE, OP_MKDIR, { directory: workDir, name: 'reports' }));

        const error = (sent[0].payload as FileError).error;
        expect(error.code).toBe(ERROR_FILE_ACCESS_OFF);
        expect(error.message).toBe('File access is off on this device. To allow it, run on the device: '
            + 'pinggy device connect --files on');
        expect(fs.existsSync(path.join(workDir, 'reports'))).toBe(false);
    });

    test('reads the answer on every request, so a new one applies with no restart', async () => {
        const allowed = { value: false };
        const { handler, sent } = recordingHandler(allowed);

        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: workDir }));
        allowed.value = true;
        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: workDir }));

        expect((sent[0].payload as FileError).error.code).toBe(ERROR_FILE_ACCESS_OFF);
        expect(sent[1].payload).not.toHaveProperty('error');
    });

    test('a dashboard that has the file manager off answers first', async () => {
        const sent: Envelope[] = [];
        const handler = new FileHandler({ send: (frame) => sent.push(frame), fileAccessAllowed: () => false });

        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: workDir }));

        expect((sent[0].payload as FileError).error.code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });
});
