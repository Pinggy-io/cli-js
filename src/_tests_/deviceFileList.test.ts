import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCapabilities } from '../devices/deviceAgent.js';
import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH, ERROR_INVALID_PAYLOAD,
    ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_UNSUPPORTED_OP, FileError,
    FileListAnswer, FileListRequest, FileListResult, OP_LIST,
} from '../devices/files/file_schema.js';
import {
    FileListDependencies, FileSystemReader, listFolder, machineFileSystem,
} from '../devices/files/fileList.js';
import { FileHandler } from '../devices/files/fileHandler.js';

/**
 * `file/list`, against a real temp folder where the OS allows it, and a fake filesystem for Windows,
 * a failing `lstat`, and a read that never finishes.
 */

const MAX_FRAME_BYTES = 32768;
const ROOMY_BUDGET = 1_000_000;
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let workDir: string;

function machine(home: string = workDir): FileListDependencies {
    return { fs: { ...machineFileSystem, homedir: () => home }, platform: process.platform };
}

function makeFolder(name: string): string {
    const folder = path.join(workDir, name);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function writeFile(folder: string, name: string, sizeBytes = 0, modifiedEpochSeconds?: number): void {
    const target = path.join(folder, name);
    fs.writeFileSync(target, Buffer.alloc(sizeBytes, 'a'));
    if (modifiedEpochSeconds !== undefined) {
        fs.utimesSync(target, modifiedEpochSeconds, modifiedEpochSeconds);
    }
}

async function list(requested: FileListRequest, dependencies: FileListDependencies = machine(),
                    budget = ROOMY_BUDGET): Promise<FileListAnswer> {
    const result = await listFolder(requested, budget, dependencies);
    if ('error' in result) {
        throw new Error(`Expected a page, got ${result.error.code}: ${result.error.message}`);
    }
    return result;
}

async function listError(requested: FileListRequest, dependencies: FileListDependencies = machine()):
    Promise<FileError['error']> {
    const result = await listFolder(requested, ROOMY_BUDGET, dependencies);
    if (!('error' in result)) {
        throw new Error(`Expected an error, got a page of ${result.entries.length}`);
    }
    return result.error;
}

function names(answer: FileListAnswer): string[] {
    return answer.entries.map((entry) => entry.name);
}

type FakeKind = 'file' | 'dir' | 'link';

function fakeDirent(name: string, kind: FakeKind): fs.Dirent {
    return {
        name,
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'link',
    } as unknown as fs.Dirent;
}

function fakeStats(kind: FakeKind, sizeBytes = 0, modifiedMillis = 1_763_000_000_000): fs.Stats {
    return {
        size: sizeBytes,
        mtimeMs: modifiedMillis,
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'link',
    } as unknown as fs.Stats;
}

function rejected(code: string): Promise<never> {
    return Promise.reject(Object.assign(new Error(`${code}: fake`), { code }));
}

beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-list-'));
});

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('which folder is listed', () => {
    test('no path lists the home folder, with home and roots', async () => {
        const home = makeFolder('home-alice');
        writeFile(home, 'notes.txt', 3);

        const answer = await list({}, machine(home));

        expect(answer.path).toBe(home);
        expect(answer.home).toBe(home);
        expect(answer.roots).toEqual(isWindows ? expect.any(Array) : ['/']);
        expect(names(answer)).toEqual(['notes.txt']);
    });

    test('a named path is normalised, and carries no home or roots', async () => {
        const folder = makeFolder('normalised/inner');

        const answer = await list({ path: `${folder}${path.sep}..${path.sep}inner${path.sep}` });

        expect(answer.path).toBe(folder);
        expect(answer.parent).toBe(path.dirname(folder));
        expect(answer.separator).toBe(path.sep);
        expect(answer.home).toBeUndefined();
        expect(answer.roots).toBeUndefined();
    });

    (isWindows ? test.skip : test)('a root has no parent', async () => {
        const answer = await list({ path: '/', limit: 1 });

        expect(answer.path).toBe('/');
        expect(answer.parent).toBeUndefined();
    });
});

describe('a path that cannot be listed', () => {
    test.each([
        ['empty', ''],
        ['relative', 'projects'],
        ['a NUL byte', '/home/alice\0/projects'],
        ['over 4096 bytes', `/${'a'.repeat(4100)}`],
    ])('%s is invalid_path, before any read', async (_case, requestedPath) => {
        const neverRead: FileSystemReader = {
            ...machineFileSystem,
            readdir: () => { throw new Error('read a path that should have been refused'); },
        };

        const error = await listError({ path: requestedPath }, { fs: neverRead, platform: process.platform });

        expect(error.code).toBe(ERROR_INVALID_PATH);
    });

    test('a folder that does not exist is path_not_found', async () => {
        const error = await listError({ path: path.join(workDir, 'gone') });

        expect(error.code).toBe(ERROR_PATH_NOT_FOUND);
        expect(error.message).toContain('ENOENT');
    });

    test('a file is not_a_directory', async () => {
        const folder = makeFolder('has-a-file');
        writeFile(folder, 'plain.txt', 1);

        const error = await listError({ path: path.join(folder, 'plain.txt') });

        expect(error.code).toBe(ERROR_NOT_A_DIRECTORY);
    });

    (isWindows || isRoot ? test.skip : test)('an unreadable folder is permission_denied', async () => {
        const locked = makeFolder('locked');
        fs.chmodSync(locked, 0o000);
        try {
            const error = await listError({ path: locked });

            expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        } finally {
            fs.chmodSync(locked, 0o755);
        }
    });
});

describe('hidden entries', () => {
    let folder: string;

    beforeAll(() => {
        folder = makeFolder('hidden');
        makeFolder('hidden/.git');
        writeFile(folder, '.env', 4);
        writeFile(folder, 'notes.txt', 4);
    });

    test('are left out and not counted by default', async () => {
        const answer = await list({ path: folder });

        expect(names(answer)).toEqual(['notes.txt']);
        expect(answer.total).toBe(1);
        expect(answer.entries[0].hidden).toBeUndefined();
    });

    test('are sent with hidden: true when asked for, and counted', async () => {
        const answer = await list({ path: folder, include_hidden: true });

        expect(names(answer)).toEqual(['.git', '.env', 'notes.txt']);
        expect(answer.total).toBe(3);
        expect(answer.entries.map((entry) => entry.hidden)).toEqual([true, true, undefined]);
    });
});

describe('sorting', () => {
    let folder: string;

    beforeAll(() => {
        folder = makeFolder('sorting');
        makeFolder('sorting/src');
        makeFolder('sorting/Build');
        makeFolder('sorting/docs');
        writeFile(folder, 'file10.txt', 2048, 1_763_000_300);
        writeFile(folder, 'file2.txt', 5120, 1_763_000_100);
        writeFile(folder, 'README.md', 1024, 1_763_000_200);
        fs.utimesSync(path.join(folder, 'src'), 1_763_000_030, 1_763_000_030);
        fs.utimesSync(path.join(folder, 'Build'), 1_763_000_010, 1_763_000_010);
        fs.utimesSync(path.join(folder, 'docs'), 1_763_000_020, 1_763_000_020);
    });

    test('by name: folders first, case-insensitive, numbers in natural order', async () => {
        const answer = await list({ path: folder });

        expect(names(answer)).toEqual(['Build', 'docs', 'src', 'file2.txt', 'file10.txt', 'README.md']);
    });

    test('by size: folders first by name, then files smallest first', async () => {
        const answer = await list({ path: folder, sort_by: 'size' });

        expect(names(answer)).toEqual(['Build', 'docs', 'src', 'README.md', 'file10.txt', 'file2.txt']);
    });

    test('by size, desc: both groups flip, folders stay on top', async () => {
        const answer = await list({ path: folder, sort_by: 'size', sort_order: 'desc' });

        expect(names(answer)).toEqual(['src', 'docs', 'Build', 'file2.txt', 'file10.txt', 'README.md']);
    });

    test('by modified: folders first, each group oldest first', async () => {
        const answer = await list({ path: folder, sort_by: 'modified' });

        expect(names(answer)).toEqual(['Build', 'docs', 'src', 'file2.txt', 'README.md', 'file10.txt']);
    });

    test('entries carry size for files only, and modified time in epoch seconds', async () => {
        const answer = await list({ path: folder });
        const byName = new Map(answer.entries.map((entry) => [entry.name, entry]));

        expect(byName.get('Build')).toEqual({ name: 'Build', type: 'directory', modified_at: 1_763_000_010 });
        expect(byName.get('file2.txt')).toEqual(
            { name: 'file2.txt', type: 'file', size_bytes: 5120, modified_at: 1_763_000_100 });
    });
});

describe('paging', () => {
    let folder: string;

    beforeAll(() => {
        folder = makeFolder('paging');
        for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
            writeFile(folder, name, 1);
        }
    });

    test('a first page names where the next starts', async () => {
        const answer = await list({ path: folder, limit: 2 });

        expect(names(answer)).toEqual(['a.txt', 'b.txt']);
        expect(answer.total).toBe(5);
        expect(answer.offset).toBe(0);
        expect(answer.next_offset).toBe(2);
    });

    test('offset counts entries, not pages', async () => {
        const answer = await list({ path: folder, offset: 1, limit: 2 });

        expect(names(answer)).toEqual(['b.txt', 'c.txt']);
        expect(answer.next_offset).toBe(3);
    });

    test('the last page has no next_offset', async () => {
        const answer = await list({ path: folder, offset: 4, limit: 2 });

        expect(names(answer)).toEqual(['e.txt']);
        expect(answer.next_offset).toBeUndefined();
    });

    test('an offset past the end is an empty page, not an error', async () => {
        const answer = await list({ path: folder, offset: 10 });

        expect(answer.entries).toEqual([]);
        expect(answer.total).toBe(5);
        expect(answer.next_offset).toBeUndefined();
    });

    test('an empty folder is an empty page', async () => {
        const empty = makeFolder('empty');

        const answer = await list({ path: empty });

        expect(answer).toEqual({
            path: empty, parent: workDir, separator: path.sep, total: 0, offset: 0, entries: [],
        });
    });

    test('the frame budget cuts a page short, and next_offset follows the cut', async () => {
        const longNames = makeFolder('long-names');
        for (let index = 0; index < 60; index++) {
            writeFile(longNames, `${String(index).padStart(3, '0')}-${'x'.repeat(180)}.jpg`, 1);
        }
        const budget = 4000;

        const answer = await list({ path: longNames }, machine(), budget);

        expect(answer.entries.length).toBeGreaterThan(0);
        expect(answer.entries.length).toBeLessThan(60);
        expect(answer.next_offset).toBe(answer.entries.length);
        expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(budget);
    });
});

(isWindows ? describe.skip : describe)('symlinks', () => {
    let folder: string;

    beforeAll(() => {
        folder = makeFolder('links');
        const target = makeFolder('links-target');
        writeFile(target, 'inside.txt', 1);
        fs.symlinkSync(target, path.join(folder, 'latest'));
        fs.symlinkSync(path.join(workDir, 'removed'), path.join(folder, 'old'));
    });

    test('a link names its target and what is there, and a broken link is missing', async () => {
        const answer = await list({ path: folder });
        const byName = new Map(answer.entries.map((entry) => [entry.name, entry]));

        expect(byName.get('latest')).toMatchObject({
            type: 'symlink', link_target: path.join(workDir, 'links-target'), target_type: 'directory',
        });
        expect(byName.get('old')).toMatchObject({ type: 'symlink', target_type: 'missing' });
        expect(byName.get('latest')?.size_bytes).toBeUndefined();
    });

    test('a link to a folder is listed under the link path', async () => {
        const linkPath = path.join(folder, 'latest');

        const answer = await list({ path: linkPath });

        expect(answer.path).toBe(linkPath);
        expect(names(answer)).toEqual(['inside.txt']);
    });
});

describe('a fake filesystem', () => {
    test('an entry lstat cannot read is unknown, and the rest carry on', async () => {
        const fake: FileSystemReader = {
            ...machineFileSystem,
            readdir: () => Promise.resolve([fakeDirent('pagefile.sys', 'file'), fakeDirent('notes.txt', 'file')]),
            lstat: (target) => (target.endsWith('pagefile.sys')
                ? rejected('EBUSY')
                : Promise.resolve(fakeStats('file', 7))),
        };

        const answer = await list({ path: '/fake' }, { fs: fake, platform: 'linux' });

        expect(answer.entries).toEqual([
            { name: 'notes.txt', type: 'file', size_bytes: 7, modified_at: 1_763_000_000 },
            { name: 'pagefile.sys', type: 'unknown' },
        ]);
    });

    test('Windows: backslash paths, the drive as parent, and the drives that answer as roots', async () => {
        const fake: FileSystemReader = {
            ...machineFileSystem,
            homedir: () => 'C:\\Users\\alice',
            readdir: () => Promise.resolve([fakeDirent('Documents', 'dir')]),
            lstat: () => Promise.resolve(fakeStats('dir')),
            access: (target) => (target === 'C:\\' || target === 'D:\\' ? Promise.resolve() : rejected('ENOENT')),
        };

        const answer = await list({}, { fs: fake, platform: 'win32' });

        expect(answer.path).toBe('C:\\Users\\alice');
        expect(answer.parent).toBe('C:\\Users');
        expect(answer.separator).toBe('\\');
        expect(answer.roots).toEqual(['C:\\', 'D:\\']);
    });

    test('Windows: a drive is a root, with no parent', async () => {
        const fake: FileSystemReader = { ...machineFileSystem, readdir: () => Promise.resolve([]) };

        const answer = await list({ path: 'D:\\' }, { fs: fake, platform: 'win32' });

        expect(answer.path).toBe('D:\\');
        expect(answer.parent).toBeUndefined();
    });
});

describe('the file channel handler', () => {
    function recordingHandler(dependencies: Partial<ConstructorParameters<typeof FileHandler>[0]> = {}) {
        const sent: Envelope[] = [];
        const handler = new FileHandler({ send: (frame) => sent.push(frame), ...dependencies });
        return { handler, sent };
    }

    function payloadOf(frame: Envelope): FileListResult {
        return frame.payload as FileListResult;
    }

    test('refuses every request until a welcome enables it', async () => {
        const { handler, sent } = recordingHandler({ fileList: machine() });

        await handler.handle(request(CHANNEL_FILE, OP_LIST, {}));
        handler.configure(undefined, MAX_FRAME_BYTES);
        await handler.handle(request(CHANNEL_FILE, OP_LIST, {}));

        expect(sent.map((frame) => (payloadOf(frame) as FileError).error.code))
            .toEqual([ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_MANAGER_DISABLED]);
    });

    test('answers a list on the same id and op', async () => {
        const { handler, sent } = recordingHandler({ fileList: machine() });
        handler.configure(true, MAX_FRAME_BYTES);
        const asked = request(CHANNEL_FILE, OP_LIST, { path: workDir, limit: 1 });

        await handler.handle(asked);

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_LIST, id: asked.id });
        expect((payloadOf(sent[0]) as FileListAnswer).path).toBe(workDir);
    });

    test.each([
        ['a negative offset', { offset: -1 }],
        ['a fractional offset', { offset: 1.5 }],
        ['an offset as text', { offset: '1' }],
        ['a limit of 0', { limit: 0 }],
        ['a limit over 500', { limit: 501 }],
        ['an unknown sort', { sort_by: 'type' }],
        ['an unknown order', { sort_order: 'up' }],
        ['a null path', { path: null }],
    ])('%s is invalid_payload', async (_case, payload) => {
        const { handler, sent } = recordingHandler({ fileList: machine() });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_LIST, payload));

        expect((payloadOf(sent[0]) as FileError).error.code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('an unknown op is unsupported_op, on that op', async () => {
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, 'stat', { path: workDir }));

        expect(sent[0].op).toBe('stat');
        expect((payloadOf(sent[0]) as FileError).error.code).toBe(ERROR_UNSUPPORTED_OP);
    });

    test('a frame that is not a request gets no answer', async () => {
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle({ ...request(CHANNEL_FILE, OP_LIST, {}), kind: 'res' });

        expect(sent).toEqual([]);
    });

    test('a read that never finishes is file_timeout', async () => {
        const stuck: FileSystemReader = { ...machineFileSystem, readdir: () => new Promise(() => undefined) };
        const { handler, sent } = recordingHandler({
            fileList: { fs: stuck, platform: process.platform }, listTimeoutMillis: 50,
        });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: workDir }));

        expect((payloadOf(sent[0]) as FileError).error.code).toBe(ERROR_FILE_TIMEOUT);
    });

    test('the whole answer frame fits max_frame_bytes', async () => {
        const crowded = makeFolder('crowded');
        for (let index = 0; index < 400; index++) {
            writeFile(crowded, `${String(index).padStart(4, '0')}-${'y'.repeat(200)}.log`, 1);
        }
        const { handler, sent } = recordingHandler({ fileList: machine() });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: crowded, limit: 500 }));

        const answer = payloadOf(sent[0]) as FileListAnswer;
        expect(answer.entries.length).toBeLessThan(400);
        expect(answer.next_offset).toBe(answer.entries.length);
        expect(Buffer.byteLength(JSON.stringify(sent[0]), 'utf8')).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    });
});

describe('capabilities', () => {
    test('file_manager is advertised, with or without a terminal', () => {
        expect(buildCapabilities(false)).toContain('file_manager');
        expect(buildCapabilities(true)).toContain('file_manager');
    });
});
