import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_EXISTS, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT, ERROR_INVALID_NAME,
    ERROR_INVALID_PATH, ERROR_INVALID_PAYLOAD, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED,
    FileError, FileMkdirResult, OP_MKDIR,
} from '../devices/files/file_schema.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import { MkdirDependencies, makeFolder, windowsNameProblem } from '../devices/files/fileMkdir.js';
import { FileSystemMaker, machineFileSystem, machineFileSystemMaker } from '../devices/files/fileSystem.js';

/**
 * `file/mkdir`, against a real temp folder where the OS allows it, and a fake maker for Windows' name rules and a
 * call that never returns.
 */

const MAX_FRAME_BYTES = 32768;
const CALL_TIMEOUT_MILLIS = 2_000;
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** `chmod` checks nothing as root or on Windows. */
const permissionTest = isWindows || isRoot ? test.skip : test;

let workDir: string;

function dependencies(overrides: Partial<MkdirDependencies> = {}): MkdirDependencies {
    return { maker: machineFileSystemMaker, platform: process.platform, callTimeoutMillis: CALL_TIMEOUT_MILLIS,
        ...overrides };
}

function onLinux(maker: FileSystemMaker): MkdirDependencies {
    return dependencies({ maker, platform: 'linux' });
}

function onWindows(maker: FileSystemMaker): MkdirDependencies {
    return dependencies({ maker, platform: 'win32' });
}

/** A maker that records each folder it was asked to make, and makes none. */
function recordingMaker(): { maker: FileSystemMaker; made: string[] } {
    const made: string[] = [];
    return { maker: { mkdir: (target) => { made.push(target); return Promise.resolve(); } }, made };
}

function errorOf(result: FileMkdirResult): FileError['error'] {
    if (!('error' in result)) {
        throw new Error(`Expected an error, got ${JSON.stringify(result)}`);
    }
    return result.error;
}

/** True when this temp disk takes `A` and `a` for 1 name, as macOS and Windows do by default. */
function ignoresLetterCase(): boolean {
    const probe = path.join(workDir, 'case-probe');
    fs.writeFileSync(probe, '');
    return fs.existsSync(path.join(workDir, 'CASE-PROBE'));
}

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-mkdir-'));
});

afterEach(() => {
    fs.chmodSync(workDir, 0o755);
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('making a folder', () => {
    test('a new, empty folder, answered with its path', async () => {
        const answer = await makeFolder({ directory: workDir, name: 'reports' }, dependencies());

        expect(answer).toEqual({ path: path.join(workDir, 'reports') });
        expect(fs.statSync(path.join(workDir, 'reports')).isDirectory()).toBe(true);
        expect(fs.readdirSync(path.join(workDir, 'reports'))).toEqual([]);
    });

    test('a dot name is made like any other', async () => {
        const answer = await makeFolder({ directory: workDir, name: '.cache' }, dependencies());

        expect(answer).toEqual({ path: path.join(workDir, '.cache') });
    });

    test.each([
        ['a folder', (target: string) => fs.mkdirSync(target)],
        ['a file', (target: string) => fs.writeFileSync(target, 'kept')],
    ])('a name taken by %s is file_exists, and nothing changes', async (_case, plant) => {
        const target = path.join(workDir, 'reports');
        plant(target);
        const before = fs.statSync(target);

        const error = errorOf(await makeFolder({ directory: workDir, name: 'reports' }, dependencies()));

        expect(error).toEqual({ code: ERROR_FILE_EXISTS, message: 'A file or folder with this name already exists.' });
        expect(fs.statSync(target).isDirectory()).toBe(before.isDirectory());
        if (before.isFile()) {
            expect(fs.readFileSync(target, 'utf8')).toBe('kept');
        }
    });

    test('a name that differs only in letter case is taken where the disk ignores case', async () => {
        fs.mkdirSync(path.join(workDir, 'reports'));

        const answer = await makeFolder({ directory: workDir, name: 'Reports' }, dependencies());

        if (ignoresLetterCase()) {
            expect(errorOf(answer).code).toBe(ERROR_FILE_EXISTS);
        } else {
            expect(answer).toEqual({ path: path.join(workDir, 'Reports') });
        }
    });

    test('a missing directory is path_not_found', async () => {
        const error = errorOf(await makeFolder({ directory: path.join(workDir, 'gone'), name: 'reports' },
            dependencies()));

        expect(error.code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a directory that is a file is not_a_directory, or path_not_found on Windows', async () => {
        const file = path.join(workDir, 'notes.txt');
        fs.writeFileSync(file, 'a');

        const error = errorOf(await makeFolder({ directory: file, name: 'reports' }, dependencies()));

        expect(error.code).toBe(isWindows ? ERROR_PATH_NOT_FOUND : ERROR_NOT_A_DIRECTORY);
    });

    permissionTest('a directory the agent cannot write is permission_denied', async () => {
        fs.chmodSync(workDir, 0o555);

        const error = errorOf(await makeFolder({ directory: workDir, name: 'reports' }, dependencies()));

        expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        expect(fs.existsSync(path.join(workDir, 'reports'))).toBe(false);
    });

    test('a call that never returns is file_timeout', async () => {
        const hung = dependencies({ maker: { mkdir: () => new Promise(() => undefined) }, callTimeoutMillis: 50 });

        const error = errorOf(await makeFolder({ directory: workDir, name: 'reports' }, hung));

        expect(error.code).toBe(ERROR_FILE_TIMEOUT);
    });
});

describe('the request', () => {
    test.each([
        ['an empty name', ''],
        ['.', '.'],
        ['..', '..'],
        ['a name with /', 'a/b'],
        ['a name with a NUL byte', 'a\0b'],
        ['a 256-byte name', 'a'.repeat(256)],
    ])('%s is invalid_payload, and no folder is made', async (_case, name) => {
        const { maker, made } = recordingMaker();

        const error = errorOf(await makeFolder({ directory: '/data', name }, onLinux(maker)));

        expect(error.code).toBe(ERROR_INVALID_PAYLOAD);
        expect(made).toEqual([]);
    });

    test('\\ is a separator on Windows only', async () => {
        const { maker, made } = recordingMaker();

        const windows = await makeFolder({ directory: 'C:\\data', name: 'a\\b' }, onWindows(maker));
        const linux = await makeFolder({ directory: '/data', name: 'a\\b' }, onLinux(maker));

        expect(errorOf(windows).code).toBe(ERROR_INVALID_PAYLOAD);
        expect(linux).toEqual({ path: '/data/a\\b' });
        expect(made).toEqual(['/data/a\\b']);
    });

    test('a relative directory is invalid_path', async () => {
        const error = errorOf(await makeFolder({ directory: 'projects', name: 'reports' }, dependencies()));

        expect(error.code).toBe(ERROR_INVALID_PATH);
    });

    test('a new path over 4096 bytes is invalid_path, though the directory fits', async () => {
        const { maker, made } = recordingMaker();
        const directory = `/${'d'.repeat(3900)}`;

        const error = errorOf(await makeFolder({ directory, name: 'n'.repeat(250) }, onLinux(maker)));

        expect(error.code).toBe(ERROR_INVALID_PATH);
        expect(made).toEqual([]);
    });
});

describe('names Windows refuses', () => {
    test.each([
        ['a:b'], ['what?'], ['star*'], ['"quoted"'], ['<tag>'], ['a|b'],
        ['reports.'], ['trailing '],
        ['CON'], ['con'], ['con.txt'], ['NUL.tar.gz'], ['Prn'], ['aux'], ['COM1'], ['lpt9.log'],
    ])('%s is invalid_name on Windows, before the disk is touched', async (name) => {
        const { maker, made } = recordingMaker();

        const error = errorOf(await makeFolder({ directory: 'C:\\data', name }, onWindows(maker)));

        expect(error.code).toBe(ERROR_INVALID_NAME);
        expect(made).toEqual([]);
    });

    test.each([['CONSOLE'], ['COM10'], ['con-notes'], ['.hidden'], ['notes.txt']])(
        '%s is made on Windows', async (name) => {
            const { maker, made } = recordingMaker();

            const answer = await makeFolder({ directory: 'C:\\data', name }, onWindows(maker));

            expect(answer).toEqual({ path: `C:\\data\\${name}` });
            expect(made).toEqual([`C:\\data\\${name}`]);
        });

    test('Linux and macOS keep the names Windows refuses', async () => {
        const { maker, made } = recordingMaker();

        for (const name of ['a:b', 'reports.', 'CON']) {
            await makeFolder({ directory: '/data', name }, onLinux(maker));
        }

        expect(made).toEqual(['/data/a:b', '/data/reports.', '/data/CON']);
    });

    test('each message names its rule', () => {
        expect(windowsNameProblem('a:b')).toBe('A folder name on Windows cannot hold : * ? " < > |');
        expect(windowsNameProblem('reports.')).toBe('A folder name on Windows cannot end with a dot or a space.');
        expect(windowsNameProblem('con.txt')).toBe('CON is a device name on Windows.');
        expect(windowsNameProblem('reports')).toBeNull();
    });
});

describe('the file channel handler', () => {
    function recordingHandler(dependencies: Partial<ConstructorParameters<typeof FileHandler>[0]> = {}) {
        const sent: Envelope[] = [];
        const handler = new FileHandler({ send: (frame) => sent.push(frame), ...dependencies });
        return { handler, sent };
    }

    test('refuses a mkdir until a welcome enables it', async () => {
        const { handler, sent } = recordingHandler();

        await handler.handle(request(CHANNEL_FILE, OP_MKDIR, { directory: workDir, name: 'reports' }));

        expect((sent[0].payload as FileError).error.code).toBe(ERROR_FILE_MANAGER_DISABLED);
        expect(fs.existsSync(path.join(workDir, 'reports'))).toBe(false);
    });

    test('answers on the request id and op, with no progress and no slot', async () => {
        const { handler, sent } = recordingHandler();
        // No file_max_concurrent_operations: no delete may run, and a mkdir still does.
        handler.configure(true, MAX_FRAME_BYTES);
        const asked = request(CHANNEL_FILE, OP_MKDIR, { directory: workDir, name: 'reports' });

        await handler.handle(asked);

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_MKDIR, id: asked.id });
        expect(sent[0].payload).toEqual({ path: path.join(workDir, 'reports') });
    });

    test.each([
        ['no name', { directory: '/data' }],
        ['a name that is not text', { directory: '/data', name: 7 }],
        ['no directory', { name: 'reports' }],
    ])('%s is invalid_payload', async (_case, payload) => {
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_MKDIR, payload));

        expect((sent[0].payload as FileError).error.code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('a mkdir that never returns is file_timeout through the gate', async () => {
        const { handler, sent } = recordingHandler({
            fileSystem: { fs: machineFileSystem, platform: process.platform },
            maker: { mkdir: () => new Promise(() => undefined) },
            mkdirTimeoutMillis: 50,
        });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_MKDIR, { directory: workDir, name: 'reports' }));

        expect((sent[0].payload as FileError).error.code).toBe(ERROR_FILE_TIMEOUT);
    });
});
