import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH,
    ERROR_INVALID_PAYLOAD, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, FileError, FileStatAnswer,
    FileStatRequest, FileStatResult, OP_STAT,
} from '../devices/files/file_schema.js';
import { statPath } from '../devices/files/fileStat.js';
import { FileSystemDependencies, FileSystemReader, machineFileSystem } from '../devices/files/fileSystem.js';
import { FileHandler } from '../devices/files/fileHandler.js';

/**
 * `file/stat`, against a real temp folder where the OS allows it, and a fake filesystem for Windows,
 * the special mode bits, a missing birth time, a failing disk, and the frame budget.
 */

const MAX_FRAME_BYTES = 32768;
const ROOMY_BUDGET = 1_000_000;
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** Symlinks need a privilege on Windows, and `chmod` checks nothing as root or on Windows. */
const posixTest = isWindows ? test.skip : test;
const permissionTest = isWindows || isRoot ? test.skip : test;

const MODIFIED_EPOCH_SECONDS = 1_763_300_000;
const ACCESSED_EPOCH_SECONDS = 1_763_379_000;

let workDir: string;

function machine(): FileSystemDependencies {
    return { fs: machineFileSystem, platform: process.platform };
}

function makeFolder(name: string): string {
    const folder = path.join(workDir, name);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function writeFile(folder: string, name: string, sizeBytes = 0): string {
    const target = path.join(folder, name);
    fs.writeFileSync(target, Buffer.alloc(sizeBytes, 'a'));
    return target;
}

async function stat(requested: FileStatRequest, dependencies: FileSystemDependencies = machine(),
                    budget = ROOMY_BUDGET): Promise<FileStatAnswer> {
    const result = await statPath(requested, budget, dependencies);
    if ('error' in result) {
        throw new Error(`Expected details, got ${result.error.code}: ${result.error.message}`);
    }
    return result;
}

async function statError(requested: FileStatRequest, dependencies: FileSystemDependencies = machine(),
                         budget = ROOMY_BUDGET): Promise<FileError['error']> {
    const result = await statPath(requested, budget, dependencies);
    if (!('error' in result)) {
        throw new Error(`Expected an error, got details of a ${result.type}`);
    }
    return result.error;
}

interface FakeStatsShape {
    kind: 'file' | 'dir' | 'link' | 'socket';
    sizeBytes?: number;
    mode?: number;
    uid?: number;
    gid?: number;
    birthMillis?: number;
}

function fakeStats(shape: FakeStatsShape): fs.Stats {
    return {
        size: shape.sizeBytes ?? 0,
        mode: shape.mode ?? 0o100644,
        uid: shape.uid ?? 1000,
        gid: shape.gid ?? 1000,
        mtimeMs: MODIFIED_EPOCH_SECONDS * 1000,
        atimeMs: ACCESSED_EPOCH_SECONDS * 1000,
        birthtimeMs: shape.birthMillis ?? 1_763_000_000_000,
        isDirectory: () => shape.kind === 'dir',
        isFile: () => shape.kind === 'file',
        isSymbolicLink: () => shape.kind === 'link',
    } as unknown as fs.Stats;
}

function fakeDirent(name: string): fs.Dirent {
    return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as unknown as fs.Dirent;
}

function fake(overrides: Partial<FileSystemReader>, platform: NodeJS.Platform = 'linux'): FileSystemDependencies {
    return { fs: { ...machineFileSystem, ...overrides }, platform };
}

function rejected(code: string, message = `${code}: fake`): Promise<never> {
    return Promise.reject(Object.assign(new Error(message), { code }));
}

beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-stat-'));
});

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('a file', () => {
    test('size, times, mode, owner and access, from lstat', async () => {
        const file = writeFile(makeFolder('plain'), 'notes.txt', 1834);
        fs.chmodSync(file, 0o644);
        fs.utimesSync(file, ACCESSED_EPOCH_SECONDS, MODIFIED_EPOCH_SECONDS);

        const answer = await stat({ path: file });

        expect(answer).toMatchObject({
            path: file, name: 'notes.txt', type: 'file', size_bytes: 1834,
            modified_at: MODIFIED_EPOCH_SECONDS, accessed_at: ACCESSED_EPOCH_SECONDS,
        });
        expect(answer.hidden).toBeUndefined();
        if (!isWindows) {
            expect(answer).toMatchObject({
                mode: '0644', uid: process.getuid!(), gid: process.getgid!(),
                readable: true, writable: true, executable: false,
            });
        }
    });

    posixTest('an executable file says so', async () => {
        const file = writeFile(makeFolder('runnable'), 'run.sh', 10);
        fs.chmodSync(file, 0o755);

        const answer = await stat({ path: file });

        expect(answer.mode).toBe('0755');
        expect(answer.executable).toBe(true);
    });

    test('a dot name is hidden, whatever include_hidden says', async () => {
        const file = writeFile(makeFolder('dotted'), '.bashrc', 5);

        expect((await stat({ path: file })).hidden).toBe(true);
        expect((await stat({ path: file, include_hidden: false })).hidden).toBe(true);
    });

    test('created_at comes from the birth time, and is left off when it is 0', async () => {
        const born = fake({ lstat: () => Promise.resolve(fakeStats({ kind: 'file', birthMillis: 1_763_000_000_500 })) });
        const unborn = fake({ lstat: () => Promise.resolve(fakeStats({ kind: 'file', birthMillis: 0 })) });

        expect((await stat({ path: '/srv/a.txt' }, born)).created_at).toBe(1_763_000_000);
        expect('created_at' in (await stat({ path: '/srv/a.txt' }, unborn))).toBe(false);
    });

    test.each([
        ['setuid', 0o104755, '4755'],
        ['setgid', 0o102755, '2755'],
        ['sticky', 0o041777, '1777'],
        ['nothing at all', 0o100000, '0000'],
    ])('mode shows the %s bits', async (_bits, rawMode, expected) => {
        const reader = fake({ lstat: () => Promise.resolve(fakeStats({ kind: 'file', mode: rawMode })) });

        expect((await stat({ path: '/usr/bin/tool' }, reader)).mode).toBe(expected);
    });

    test('a socket or pipe is other', async () => {
        const reader = fake({ lstat: () => Promise.resolve(fakeStats({ kind: 'socket' })) });

        const answer = await stat({ path: '/run/agent.sock' }, reader);

        expect(answer.type).toBe('other');
        expect(answer.size_bytes).toBeUndefined();
    });

    test('the path is normalised', async () => {
        const folder = makeFolder('normalised');
        writeFile(folder, 'a.txt');

        const answer = await stat({ path: `${folder}${path.sep}inner${path.sep}..${path.sep}a.txt` });

        expect(answer.path).toBe(path.join(folder, 'a.txt'));
    });
});

describe('a folder', () => {
    test('entry_count leaves dot names out unless include_hidden', async () => {
        const folder = makeFolder('counted');
        writeFile(folder, 'a.txt');
        writeFile(folder, 'b.txt');
        writeFile(folder, '.env');
        makeFolder('counted/sub');

        const plain = await stat({ path: folder });
        const withHidden = await stat({ path: folder, include_hidden: true });

        expect(plain).toMatchObject({ type: 'directory', name: 'counted', entry_count: 3 });
        expect(plain.size_bytes).toBeUndefined();
        expect(withHidden.entry_count).toBe(4);
        if (!isWindows) {
            expect(plain.executable).toBe(true);
        }
    });

    permissionTest('a folder that cannot be read answers without entry_count', async () => {
        const folder = makeFolder('closed');
        writeFile(folder, 'secret.txt');
        fs.chmodSync(folder, 0o000);
        try {
            const answer = await stat({ path: folder });

            expect(answer).toMatchObject({
                type: 'directory', mode: '0000', readable: false, writable: false, executable: false,
            });
            expect('entry_count' in answer).toBe(false);
        } finally {
            fs.chmodSync(folder, 0o755);
        }
    });

    permissionTest('a file in a folder that can be listed but not entered is permission_denied', async () => {
        const folder = makeFolder('listable');
        const file = writeFile(folder, 'report.txt');
        fs.chmodSync(folder, 0o644);
        try {
            expect((await statError({ path: file })).code).toBe(ERROR_PERMISSION_DENIED);
        } finally {
            fs.chmodSync(folder, 0o755);
        }
    });
});

describe('a symlink', () => {
    posixTest('is described as itself, with its target\'s type and size', async () => {
        writeFile(makeFolder('links-file/docs'), 'report.pdf', 2048);
        const link = path.join(makeFolder('links-file/links'), 'report');
        fs.symlinkSync('../docs/report.pdf', link);

        const answer = await stat({ path: link });

        expect(answer).toMatchObject({
            path: link, name: 'report', type: 'symlink',
            link_target: '../docs/report.pdf', target_type: 'file', target_size_bytes: 2048,
        });
        expect(answer.mode).toMatch(/^[0-7]{4}$/);
        expect(answer.size_bytes).toBeUndefined();
        expect(answer.readable).toBeUndefined();
        expect(answer.writable).toBeUndefined();
        expect(answer.executable).toBeUndefined();
    });

    posixTest('a link to a folder has no target size and no entry_count', async () => {
        const folder = makeFolder('links-folder/real');
        writeFile(folder, 'a.txt');
        const link = path.join(workDir, 'links-folder', 'latest');
        fs.symlinkSync(folder, link);

        const answer = await stat({ path: link });

        expect(answer).toMatchObject({ type: 'symlink', link_target: folder, target_type: 'directory' });
        expect(answer.target_size_bytes).toBeUndefined();
        expect(answer.entry_count).toBeUndefined();
    });

    posixTest('a broken link answers, with its target missing', async () => {
        const link = path.join(makeFolder('links-broken'), 'old');
        fs.symlinkSync(path.join(workDir, 'removed'), link);

        const answer = await stat({ path: link });

        expect(answer).toMatchObject({
            type: 'symlink', link_target: path.join(workDir, 'removed'), target_type: 'missing',
        });
        expect(answer.target_size_bytes).toBeUndefined();
    });

    posixTest('a link earlier in the path is followed, and the path keeps it', async () => {
        const docs = makeFolder('links-middle/docs');
        writeFile(docs, 'report.pdf', 512);
        fs.symlinkSync(docs, path.join(workDir, 'links-middle', 'docs-link'));
        const throughLink = path.join(workDir, 'links-middle', 'docs-link', 'report.pdf');

        const answer = await stat({ path: throughLink });

        expect(answer).toMatchObject({ path: throughLink, type: 'file', size_bytes: 512 });
    });
});

describe('roots and Windows', () => {
    posixTest('/ is named by its own path', async () => {
        const answer = await stat({ path: '/' });

        expect(answer).toMatchObject({ path: '/', name: '/', type: 'directory' });
    });

    test('Windows: no mode, owner or access flags, and access is never asked', async () => {
        let accessCalls = 0;
        const reader = fake({
            lstat: () => Promise.resolve(fakeStats({ kind: 'file', sizeBytes: 48213, mode: 0o100666, uid: 0 })),
            access: () => {
                accessCalls++;
                return Promise.resolve();
            },
        }, 'win32');

        const answer = await stat({ path: 'C:\\Users\\alice\\Documents\\budget.xlsx' }, reader);

        expect(answer).toEqual({
            path: 'C:\\Users\\alice\\Documents\\budget.xlsx', name: 'budget.xlsx', type: 'file', size_bytes: 48213,
            modified_at: MODIFIED_EPOCH_SECONDS, accessed_at: ACCESSED_EPOCH_SECONDS, created_at: 1_763_000_000,
        });
        expect(accessCalls).toBe(0);
    });

    test('Windows: a drive is named by its own path', async () => {
        const reader = fake({
            lstat: () => Promise.resolve(fakeStats({ kind: 'dir' })),
            readdir: () => Promise.resolve([fakeDirent('Documents'), fakeDirent('Downloads')]),
        }, 'win32');

        const answer = await stat({ path: 'D:\\' }, reader);

        expect(answer).toMatchObject({ path: 'D:\\', name: 'D:\\', type: 'directory', entry_count: 2 });
    });
});

describe('errors', () => {
    test.each([
        ['a relative path', 'notes.txt'],
        ['an empty path', ''],
        ['a NUL byte', '/home/alice/a\0b'],
        ['over 4096 bytes', `/${'a'.repeat(4096)}`],
    ])('%s is invalid_path', async (_case, requested) => {
        expect((await statError({ path: requested })).code).toBe(ERROR_INVALID_PATH);
    });

    test('a missing path is path_not_found', async () => {
        const error = await statError({ path: path.join(workDir, 'gone.txt') });

        expect(error.code).toBe(ERROR_PATH_NOT_FOUND);
        expect(error.message).toContain('ENOENT');
    });

    test('a path under a file is path_not_found, not not_a_directory', async () => {
        const file = writeFile(makeFolder('under-file'), 'notes.txt');

        expect((await statError({ path: path.join(file, 'draft') })).code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('any other lstat failure is file_operation_failed, with Node\'s message', async () => {
        const reader = fake({ lstat: () => rejected('EIO', "EIO: i/o error, lstat '/mnt/usb/a.jpg'") });

        const error = await statError({ path: '/mnt/usb/a.jpg' }, reader);

        expect(error).toEqual({ code: ERROR_FILE_OPERATION_FAILED, message: "EIO: i/o error, lstat '/mnt/usb/a.jpg'" });
    });
});

describe('the frame budget', () => {
    const longLink = fake({
        lstat: () => Promise.resolve(fakeStats({ kind: 'link', mode: 0o120777 })),
        readlink: () => Promise.resolve('x'.repeat(5000)),
        stat: () => Promise.resolve(fakeStats({ kind: 'file', sizeBytes: 10 })),
    });

    test('a link target that does not fit is left off, and the rest is sent', async () => {
        const answer = await stat({ path: '/home/alice/links/long' }, longLink, 600);

        expect(answer.link_target).toBeUndefined();
        expect(answer).toMatchObject({ type: 'symlink', target_type: 'file', target_size_bytes: 10 });
        expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(600);
    });

    test('a link target that fits is sent', async () => {
        expect((await stat({ path: '/home/alice/links/long' }, longLink)).link_target).toBe('x'.repeat(5000));
    });

    test('a budget too small even without the link target is an error, not an oversized frame', async () => {
        expect((await statError({ path: '/home/alice/links/long' }, longLink, 50)).code)
            .toBe(ERROR_FILE_OPERATION_FAILED);
    });
});

describe('the file channel handler', () => {
    function recordingHandler(dependencies: Partial<ConstructorParameters<typeof FileHandler>[0]> = {}) {
        const sent: Envelope[] = [];
        const handler = new FileHandler({ send: (frame) => sent.push(frame), ...dependencies });
        return { handler, sent };
    }

    function payloadOf(frame: Envelope): FileStatResult {
        return frame.payload as FileStatResult;
    }

    test('refuses a stat until a welcome enables it', async () => {
        const { handler, sent } = recordingHandler({ fileSystem: machine() });

        await handler.handle(request(CHANNEL_FILE, OP_STAT, { path: workDir }));

        expect((payloadOf(sent[0]) as FileError).error.code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });

    test('answers a stat on the same id and op', async () => {
        const file = writeFile(makeFolder('handled'), 'a.txt', 7);
        const { handler, sent } = recordingHandler({ fileSystem: machine() });
        handler.configure(true, MAX_FRAME_BYTES);
        const asked = request(CHANNEL_FILE, OP_STAT, { path: file });

        await handler.handle(asked);

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_STAT, id: asked.id });
        expect(payloadOf(sent[0])).toMatchObject({ path: file, type: 'file', size_bytes: 7 });
    });

    test.each([
        ['no path', {}],
        ['a null path', { path: null }],
        ['a path that is a number', { path: 7 }],
        ['include_hidden as text', { path: '/home/alice', include_hidden: 'yes' }],
    ])('%s is invalid_payload', async (_case, payload) => {
        const { handler, sent } = recordingHandler({ fileSystem: machine() });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_STAT, payload));

        expect((payloadOf(sent[0]) as FileError).error.code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('a stat that never finishes is file_timeout, about the path', async () => {
        const stuck: FileSystemReader = { ...machineFileSystem, lstat: () => new Promise(() => undefined) };
        const { handler, sent } = recordingHandler({
            fileSystem: { fs: stuck, platform: process.platform }, readTimeoutMillis: 50,
        });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_STAT, { path: workDir }));

        const error = (payloadOf(sent[0]) as FileError).error;
        expect(error.code).toBe(ERROR_FILE_TIMEOUT);
        expect(error.message).toMatch(/^The path took longer than/);
    });

    test('the worst case, a 4096-byte path and link target of control characters, fits 1 frame', async () => {
        // 16 parts of 255 control characters: 4096 bytes as text, about 24 KB once JSON escapes each as \u0001.
        const longName = '\u0001'.repeat(255);
        const longPath = `/${Array.from({ length: 16 }, () => longName).join('/')}`;
        const reader = fake({
            lstat: () => Promise.resolve(fakeStats({ kind: 'link', mode: 0o120777 })),
            readlink: () => Promise.resolve('\u0001'.repeat(4095)),
            stat: () => Promise.resolve(fakeStats({ kind: 'file', sizeBytes: 10 })),
        }, 'linux');
        const { handler, sent } = recordingHandler({ fileSystem: reader });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_STAT, { path: longPath }));

        const answer = payloadOf(sent[0]) as FileStatAnswer;
        expect(Buffer.byteLength(longPath, 'utf8')).toBe(4096);
        expect(answer).toMatchObject({ path: longPath, name: longName, type: 'symlink', target_type: 'file' });
        expect(answer.link_target).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(sent[0]), 'utf8')).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    });
});
