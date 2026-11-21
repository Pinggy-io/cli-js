import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_FILE_EXISTS, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT,
    ERROR_INVALID_DESTINATION, ERROR_INVALID_NAME, ERROR_INVALID_PAYLOAD, ERROR_NOT_A_DIRECTORY, ERROR_NO_SPACE,
    ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH, ERROR_SPECIAL_FILE, FileCopyRequest,
    FileCopyResult, FileError, FileOperationAnswer, FileProgress, OP_COPY, OP_DELETE, OP_PROGRESS,
} from '../devices/files/file_schema.js';
import {
    CopyDependencies, formatBytes, keepBothName, prepareCopy, runCopy,
} from '../devices/files/fileCopy.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import {
    MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, MESSAGE_SYSTEM_FOLDER, ProtectedSources,
} from '../devices/files/fileProtectedPaths.js';
import {
    FileSystemCopier, FileSystemRemover, machineFileSystemCopier, machineFileSystemRemover,
} from '../devices/files/fileSystem.js';

/**
 * `file/copy`, against a real temp folder where the OS allows it, and a fake copier for what the OS cannot be
 * made to do on demand: a full disk, a call that never returns, a refused rename, a mounted disk, and the
 * progress timer.
 *
 * Every protected path points into the temp folder. No test copies onto a real system folder.
 */

const MAX_FRAME_BYTES = 32768;
const ROOMY_BUDGET = 1_000_000;
const CALL_TIMEOUT_MILLIS = 2_000;
const HIDDEN_SUFFIX = '0badc0de';
const MEBIBYTE = 1024 * 1024;
const MOUNTED_DEVICE = 999_999n;
const FIXED_TIME = new Date('2020-01-02T03:04:05Z');
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** Symlinks and named pipes need a privilege or do not exist on Windows. */
const posixTest = isWindows ? test.skip : test;
/** `chmod` checks nothing as root or on Windows. */
const permissionTest = isWindows || isRoot ? test.skip : test;

let workDir: string;
let sources: ProtectedSources;

function makeFolder(...parts: string[]): string {
    const folder = path.join(workDir, ...parts);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function writeFile(folder: string, name: string, contents: string | Buffer = 'a'): string {
    const target = path.join(folder, name);
    fs.writeFileSync(target, contents);
    return target;
}

function copier(overrides: Partial<FileSystemCopier> = {}): FileSystemCopier {
    return { ...machineFileSystemCopier, ...overrides };
}

function remover(overrides: Partial<FileSystemRemover> = {}): FileSystemRemover {
    return { ...machineFileSystemRemover, ...overrides };
}

function dependencies(overrides: Partial<CopyDependencies> = {}): CopyDependencies {
    return {
        copier: machineFileSystemCopier,
        remover: machineFileSystemRemover,
        platform: process.platform,
        protectedSources: sources,
        callTimeoutMillis: CALL_TIMEOUT_MILLIS,
        hiddenNameSuffix: () => HIDDEN_SUFFIX,
        ...overrides,
    };
}

function newProgress(): FileProgress {
    return { items_done: 0, items_total: 0, files_done: 0, bytes_done: 0, current_name: '' };
}

async function copyIn(copyRequest: FileCopyRequest, using: CopyDependencies = dependencies(),
                      progress: FileProgress = newProgress(), budget = ROOMY_BUDGET): Promise<FileCopyResult> {
    const prepared = await prepareCopy(copyRequest, using, budget);
    if ('error' in prepared) {
        return prepared;
    }
    progress.items_total = prepared.names.length;
    return runCopy(prepared, progress, using, budget);
}

async function copied(copyRequest: FileCopyRequest, using?: CopyDependencies,
                      progress?: FileProgress): Promise<FileOperationAnswer> {
    const result = await copyIn(copyRequest, using, progress);
    if ('error' in result) {
        throw new Error(`Expected an answer, got ${result.error.code}: ${result.error.message}`);
    }
    return result;
}

async function refused(copyRequest: FileCopyRequest, using?: CopyDependencies): Promise<FileError['error']> {
    const result = await copyIn(copyRequest, using);
    if (!('error' in result)) {
        throw new Error(`Expected an error, got ${JSON.stringify(result)}`);
    }
    return result.error;
}

function failureOf(answer: FileOperationAnswer, name: string): FileError['error'] | undefined {
    return answer.failed?.find((failure) => failure.name === name)?.error;
}

function rejected(code: string, message = `${code}: fake`): Promise<never> {
    return Promise.reject(Object.assign(new Error(message), { code }));
}

/** The same stats on another device, as a mounted disk would report. */
function onDevice(stats: fs.BigIntStats, device: bigint): fs.BigIntStats {
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: device });
}

function namesIn(folder: string): string[] {
    return fs.readdirSync(folder).sort();
}

function textOf(...parts: string[]): string {
    return fs.readFileSync(path.join(...parts), 'utf8');
}

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-copy-'));
    const home = makeFolder('home');
    const configFolder = makeFolder('home', '.config', 'pinggy');
    writeFile(configFolder, 'device.json');
    sources = {
        home, configFolder, systemFolders: [makeFolder('system')], accountsFolder: makeFolder('accounts'),
        agentFiles: [],
    };
});

afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('copying', () => {
    test('1 file: the bytes, and the modified time', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const file = writeFile(source, 'notes.txt', 'hello');
        fs.utimesSync(file, FIXED_TIME, FIXED_TIME);

        const answer = await copied({
            source_directory: source, names: ['notes.txt'], destination_directory: destination,
        });

        expect(answer).toEqual({ completed_count: 1, skipped_count: 0, failed_count: 0 });
        expect(textOf(destination, 'notes.txt')).toBe('hello');
        expect(fs.statSync(path.join(destination, 'notes.txt')).mtimeMs).toBe(FIXED_TIME.getTime());
        expect(textOf(file)).toBe('hello');
    });

    permissionTest('the permission bits stay, setuid, setgid and sticky do not', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        fs.chmodSync(writeFile(source, 'run.sh'), 0o640);
        fs.chmodSync(writeFile(source, 'tool'), 0o4755);

        await copied({ source_directory: source, names: ['run.sh', 'tool'], destination_directory: destination });

        expect(fs.statSync(path.join(destination, 'run.sh')).mode & 0o7777).toBe(0o640);
        expect(fs.statSync(path.join(destination, 'tool')).mode & 0o7777).toBe(0o755);
    });

    permissionTest('a read-only folder is filled first, then made read-only', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const locked = makeFolder('src', 'locked');
        writeFile(locked, 'inside.txt');
        fs.chmodSync(locked, 0o555);

        try {
            await copied({ source_directory: source, names: ['locked'], destination_directory: destination });

            expect(namesIn(path.join(destination, 'locked'))).toEqual(['inside.txt']);
            expect(fs.statSync(path.join(destination, 'locked')).mode & 0o777).toBe(0o555);
        } finally {
            fs.chmodSync(locked, 0o755);
            fs.chmodSync(path.join(destination, 'locked'), 0o755);
        }
    });

    test('a tree, whole, and the counts in progress', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'index.html', '12345');
        writeFile(makeFolder('src', 'web', 'css'), 'site.css', '123');
        makeFolder('src', 'web', 'empty');
        const progress = newProgress();

        const answer = await copied({
            source_directory: source, names: ['web'], destination_directory: destination,
        }, dependencies(), progress);

        expect(answer.completed_count).toBe(1);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['css', 'empty', 'index.html']);
        expect(textOf(destination, 'web', 'css', 'site.css')).toBe('123');
        expect(progress).toMatchObject({
            items_done: 1, items_total: 1, files_done: 5, files_total: 5, bytes_done: 8, bytes_total: 8,
        });
    });

    test('several names, in order, each counted', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        writeFile(source, 'b.txt');
        makeFolder('src', 'c');

        const answer = await copied({
            source_directory: source, names: ['a.txt', 'b.txt', 'c'], destination_directory: destination,
        });

        expect(answer).toEqual({ completed_count: 3, skipped_count: 0, failed_count: 0 });
        expect(namesIn(destination)).toEqual(['a.txt', 'b.txt', 'c']);
    });

    posixTest('a link is copied as a link, with the same text', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const web = makeFolder('src', 'web');
        writeFile(web, 'index.html');
        fs.symlinkSync('index.html', path.join(web, 'home.html'));
        fs.symlinkSync('/nowhere/at/all', path.join(web, 'broken'));

        await copied({ source_directory: source, names: ['web'], destination_directory: destination });

        expect(fs.readlinkSync(path.join(destination, 'web', 'home.html'))).toBe('index.html');
        expect(fs.readlinkSync(path.join(destination, 'web', 'broken'))).toBe('/nowhere/at/all');
    });

    test('a mounted disk inside a tree is copied too', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const mount = makeFolder('src', 'data', 'usb');
        writeFile(mount, 'photo.jpg');
        const mounted = copier({
            lstat: async (target) => {
                const stats = await machineFileSystemCopier.lstat(target);
                return target === mount ? onDevice(stats, MOUNTED_DEVICE) : stats;
            },
        });

        await copied({ source_directory: source, names: ['data'], destination_directory: destination },
            dependencies({ copier: mounted }));

        expect(namesIn(path.join(destination, 'data', 'usb'))).toEqual(['photo.jpg']);
    });

    test('a 3 MiB file goes in 3 pieces, and bytes_done counts them', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'big.bin', Buffer.alloc(3 * MEBIBYTE, 7));
        const pieces: number[] = [];
        const counting = copier({
            write: async (handle, buffer, length) => {
                pieces.push(length);
                await machineFileSystemCopier.write(handle, buffer, length);
            },
        });
        const progress = newProgress();

        await copied({ source_directory: source, names: ['big.bin'], destination_directory: destination },
            dependencies({ copier: counting }), progress);

        expect(pieces).toEqual([MEBIBYTE, MEBIBYTE, MEBIBYTE]);
        expect(progress.bytes_done).toBe(3 * MEBIBYTE);
        expect(fs.statSync(path.join(destination, 'big.bin')).size).toBe(3 * MEBIBYTE);
    });
});

describe('the request', () => {
    test.each([
        ['a name listed twice', { names: ['a.txt', 'a.txt'] }, 'A name is listed twice.'],
        ['a name that is a path', { names: ['a/b'] }, undefined],
        ['new_name with 2 names', { names: ['a.txt', 'b.txt'], new_name: 'c.txt' }, 'A new name needs exactly 1 name.'],
        ['a new_name that is a path', { names: ['a.txt'], new_name: '../c.txt' }, undefined],
    ])('%s is invalid_payload', async (_case, fields, message) => {
        const error = await refused({
            source_directory: makeFolder('src'), destination_directory: makeFolder('dest'), ...fields,
        });

        expect(error.code).toBe(ERROR_INVALID_PAYLOAD);
        if (message) {
            expect(error.message).toBe(message);
        }
    });

    test('a new_name Windows does not allow is invalid_name on Windows', async () => {
        const error = await refused({
            source_directory: 'C:\\data', names: ['a.txt'], destination_directory: 'C:\\data', new_name: 'a:b.txt',
        }, dependencies({ platform: 'win32' }));

        expect(error).toEqual({ code: ERROR_INVALID_NAME, message: 'A name on Windows cannot hold : * ? " < > |' });
    });

    test('a folder that is gone, and a folder that is a file', async () => {
        const source = makeFolder('src');
        writeFile(source, 'a.txt');

        expect((await refused({
            source_directory: path.join(workDir, 'gone'), names: ['a.txt'], destination_directory: source,
        })).code).toBe(ERROR_PATH_NOT_FOUND);
        expect((await refused({
            source_directory: source, names: ['a.txt'], destination_directory: path.join(source, 'a.txt'),
        })).code).toBe(ERROR_NOT_A_DIRECTORY);
    });

    test.each([
        ['into itself', ['web']],
        ['into a folder inside it', ['web', 'assets']],
    ])('a folder %s is invalid_destination, and nothing is made', async (_case, destinationParts) => {
        const source = makeFolder('src');
        makeFolder('src', 'web', 'assets');

        const error = await refused({
            source_directory: source, names: ['web'], destination_directory: path.join(source, ...destinationParts),
        });

        expect(error).toEqual({ code: ERROR_INVALID_DESTINATION, message: 'A folder cannot be copied into itself.' });
        expect(namesIn(path.join(source, 'web', 'assets'))).toEqual([]);
    });

    posixTest('a link that leads inside the folder is caught too', async () => {
        const source = makeFolder('src');
        const assets = makeFolder('src', 'web', 'assets');
        const shortcut = path.join(workDir, 'shortcut');
        fs.symlinkSync(assets, shortcut);

        const error = await refused({ source_directory: source, names: ['web'], destination_directory: shortcut });

        expect(error.code).toBe(ERROR_INVALID_DESTINATION);
    });

    test('replace onto itself, the same folder with no new_name, is invalid_destination', async () => {
        const source = makeFolder('src');
        writeFile(source, 'nginx.conf');

        const error = await refused({
            source_directory: source, names: ['nginx.conf'], destination_directory: source, on_conflict: 'replace',
        });

        expect(error).toEqual({ code: ERROR_INVALID_DESTINATION, message: 'An item cannot replace itself.' });
    });

    test('new_name copies the 1 name under that name', async () => {
        const source = makeFolder('src');
        writeFile(source, 'notes.txt', 'v1');

        await copied({
            source_directory: source, names: ['notes.txt'], destination_directory: source, new_name: 'notes-v2.txt',
        });

        expect(textOf(source, 'notes-v2.txt')).toBe('v1');
    });
});

describe('a name already taken', () => {
    test('fail, the default: every clash counted, and nothing copied', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
            writeFile(source, name, 'new');
        }
        writeFile(destination, 'a.txt', 'old');
        writeFile(destination, 'b.txt', 'old');

        const error = await refused({
            source_directory: source, names: ['a.txt', 'b.txt', 'c.txt'], destination_directory: destination,
        });

        expect(error).toEqual({
            code: ERROR_FILE_EXISTS, message: '2 items already exist in the destination.', conflict_count: 2,
            conflicts: ['a.txt', 'b.txt'],
        });
        expect(namesIn(destination)).toEqual(['a.txt', 'b.txt']);
        expect(textOf(destination, 'a.txt')).toBe('old');
    });

    test('fail on new_name lists the 1 name sent in names', async () => {
        const source = makeFolder('src');
        writeFile(source, 'notes.txt');
        writeFile(source, 'notes.bak');

        const error = await refused({
            source_directory: source, names: ['notes.txt'], destination_directory: source, new_name: 'notes.bak',
        });

        expect(error).toEqual({
            code: ERROR_FILE_EXISTS, message: '1 item already exists in the destination.', conflict_count: 1,
            conflicts: ['notes.txt'],
        });
    });

    test('fail lists at most 20 clashes, and only what fits the frame', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const names = Array.from({ length: 30 }, (_value, index) => `${index}`.padStart(200, 'x'));
        for (const name of names) {
            writeFile(source, name);
            writeFile(destination, name);
        }

        const roomy = await refused({ source_directory: source, names, destination_directory: destination });
        const prepared = await prepareCopy({ source_directory: source, names, destination_directory: destination },
            dependencies(), 2000);

        expect(roomy.conflict_count).toBe(30);
        expect(roomy.conflicts).toHaveLength(20);
        const tight = (prepared as FileError).error;
        expect(tight.conflict_count).toBe(30);
        expect(tight.conflicts!.length).toBeLessThan(20);
        expect(Buffer.byteLength(JSON.stringify(prepared), 'utf8')).toBeLessThanOrEqual(2000);
    });

    test('skip leaves the taken name and copies the rest', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt', 'new');
        writeFile(source, 'b.txt', 'new');
        writeFile(destination, 'a.txt', 'old');
        const progress = newProgress();

        const answer = await copied({
            source_directory: source, names: ['a.txt', 'b.txt'], destination_directory: destination,
            on_conflict: 'skip',
        }, dependencies(), progress);

        expect(answer).toEqual({ completed_count: 1, skipped_count: 1, failed_count: 0 });
        expect(textOf(destination, 'a.txt')).toBe('old');
        expect(textOf(destination, 'b.txt')).toBe('new');
        expect(progress).toMatchObject({ items_done: 2, files_total: 1, bytes_total: 3 });
    });

    test('keep_both takes the first free number', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'report.pdf', 'new');
        makeFolder('src', 'web');
        writeFile(destination, 'report.pdf', 'old');
        writeFile(destination, 'report (1).pdf', 'older');
        makeFolder('dest', 'web');

        const answer = await copied({
            source_directory: source, names: ['report.pdf', 'web'], destination_directory: destination,
            on_conflict: 'keep_both',
        });

        expect(answer.completed_count).toBe(2);
        expect(namesIn(destination)).toEqual(['report (1).pdf', 'report (2).pdf', 'report.pdf', 'web', 'web (1)']);
        expect(textOf(destination, 'report (2).pdf')).toBe('new');
    });

    test('keep_both in the same folder makes a second copy', async () => {
        const source = makeFolder('src');
        writeFile(source, 'nginx.conf');

        await copied({
            source_directory: source, names: ['nginx.conf'], destination_directory: source, on_conflict: 'keep_both',
        });

        expect(namesIn(source)).toEqual(['nginx (1).conf', 'nginx.conf']);
    });

    test('2 copies racing for (1): 1 gets it, the other takes (2)', async () => {
        const source = makeFolder('src');
        writeFile(source, 'report.pdf');
        const copyRequest: FileCopyRequest = {
            source_directory: source, names: ['report.pdf'], destination_directory: source, on_conflict: 'keep_both',
        };

        await Promise.all([copied(copyRequest), copied(copyRequest)]);

        expect(namesIn(source)).toEqual(['report (1).pdf', 'report (2).pdf', 'report.pdf']);
    });

    test.each([
        ['report.pdf', false, 'report (1).pdf'],
        ['archive.tar.gz', false, 'archive.tar (1).gz'],
        ['.env', false, '.env (1)'],
        ['Makefile', false, 'Makefile (1)'],
        ['web.d', true, 'web.d (1)'],
    ])('keep_both names %s as %s', (name, isFolder, expected) => {
        expect(keepBothName(name, isFolder, 1)).toBe(expected);
    });

    test('a keep_both name stays within 255 bytes, and never splits a character', () => {
        const longName = `${'é'.repeat(125)}x.pdf`;

        const renamed = keepBothName(longName, false, 12);

        expect(Buffer.byteLength(renamed, 'utf8')).toBeLessThanOrEqual(255);
        expect(renamed.endsWith(' (12).pdf')).toBe(true);
        expect(renamed).not.toContain('\ufffd');
    });
});

describe('replace', () => {
    test('a file: the new one in its place, nothing hidden left', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'nginx.conf', 'new');
        writeFile(destination, 'nginx.conf', 'old');

        const answer = await copied({
            source_directory: source, names: ['nginx.conf'], destination_directory: destination,
            on_conflict: 'replace',
        });

        expect(answer).toEqual({ completed_count: 1, skipped_count: 0, failed_count: 0 });
        expect(namesIn(destination)).toEqual(['nginx.conf']);
        expect(textOf(destination, 'nginx.conf')).toBe('new');
    });

    test('a folder: the old one gone whole, the new one in its place', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'new.html');
        writeFile(makeFolder('dest', 'web', 'old'), 'old.html');

        await copied({
            source_directory: source, names: ['web'], destination_directory: destination, on_conflict: 'replace',
        });

        expect(namesIn(destination)).toEqual(['web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['new.html']);
    });

    test('a name that is free is copied as it is', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');

        await copied({
            source_directory: source, names: ['a.txt'], destination_directory: destination, on_conflict: 'replace',
        });

        expect(namesIn(destination)).toEqual(['a.txt']);
    });

    test('a copy that fails leaves the old one as it was, and no hidden copy', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const web = makeFolder('src', 'web');
        writeFile(web, 'a.html');
        const unreadable = writeFile(web, 'b.html');
        writeFile(makeFolder('dest', 'web'), 'old.html');
        const failing = copier({
            openToRead: (target) => target === unreadable
                ? rejected('EACCES') : machineFileSystemCopier.openToRead(target),
        });

        const answer = await copied({
            source_directory: source, names: ['web'], destination_directory: destination, on_conflict: 'replace',
        }, dependencies({ copier: failing }));

        expect(failureOf(answer, 'web')!.code).toBe(ERROR_PERMISSION_DENIED);
        expect(namesIn(destination)).toEqual(['web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['old.html']);
    });

    test.each([
        ['the old one cannot move aside', (from: string) => path.basename(from) === 'web'],
        ['the copy cannot move in', (from: string) => path.basename(from).includes('pinggy-copy')],
    ])('a refused rename, as on Windows with a file open: %s', async (_case, refuses) => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'new.html');
        writeFile(makeFolder('dest', 'web'), 'old.html');
        const locking = copier({
            rename: (from, to) => refuses(from) ? rejected('EPERM') : machineFileSystemCopier.rename(from, to),
        });

        const answer = await copied({
            source_directory: source, names: ['web'], destination_directory: destination, on_conflict: 'replace',
        }, dependencies({ copier: locking }));

        expect(failureOf(answer, 'web')!.code).toBe(ERROR_PERMISSION_DENIED);
        expect(namesIn(destination)).toEqual(['web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['old.html']);
    });

    test('an old one that cannot be removed stays under its hidden name, and says so', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'new.html');
        writeFile(makeFolder('dest', 'web'), 'old.html');
        const stuck = remover({
            unlink: (target) => target.includes('pinggy-old')
                ? rejected('EACCES') : machineFileSystemRemover.unlink(target),
        });

        const answer = await copied({
            source_directory: source, names: ['web'], destination_directory: destination, on_conflict: 'replace',
        }, dependencies({ remover: stuck }));

        const failure = failureOf(answer, 'web')!;
        expect(failure.code).toBe(ERROR_PERMISSION_DENIED);
        expect(failure.message).toMatch(/^The copy is in place\. The old one stays as \.web\.pinggy-old-0badc0de: /);
        expect(namesIn(destination)).toEqual(['.web.pinggy-old-0badc0de', 'web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['new.html']);
    });

    test.each([
        ['a system folder', () => workDir, 'system', MESSAGE_SYSTEM_FOLDER],
        ['an account home', () => sources.accountsFolder, 'bob', MESSAGE_ACCOUNT_FOLDER],
        ['a file in the config folder', () => sources.configFolder, 'device.json', MESSAGE_PINGGY_FOLDER],
    ])('%s is protected_path, and stays', async (_case, destinationOf, name, message) => {
        const source = makeFolder('src');
        writeFile(source, name, 'new');
        makeFolder('accounts', 'bob');

        const answer = await copied({
            source_directory: source, names: [name], destination_directory: destinationOf(), on_conflict: 'replace',
        });

        expect(failureOf(answer, name)).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(fs.existsSync(path.join(destinationOf(), name))).toBe(true);
    });
});

describe('failures', () => {
    test('no_space: the totals against the free bytes, and nothing copied', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt', '12345');
        const full = copier({ freeBytes: async () => 2n });
        const progress = newProgress();

        const error = (await copyIn({
            source_directory: source, names: ['a.txt'], destination_directory: destination,
        }, dependencies({ copier: full }), progress) as FileError).error;

        expect(error).toEqual({
            code: ERROR_NO_SPACE, message: 'The copy needs 5 bytes. The destination disk has 2 bytes free.',
        });
        expect(progress).toMatchObject({ files_total: 1, bytes_total: 5 });
        expect(namesIn(destination)).toEqual([]);
    });

    test.each([
        [1, '1 byte'],
        [999, '999 bytes'],
        [12_400_000_000, '12.4 GB'],
        [3_100_000_000n, '3.1 GB'],
    ])('formatBytes(%s) is %s', (bytes, expected) => {
        expect(formatBytes(bytes)).toBe(expected);
    });

    test('the disk fills during the copy: no_space, and the cut-off file removed', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        writeFile(source, 'big.bin', Buffer.alloc(2 * MEBIBYTE));
        let writes = 0;
        const filling = copier({
            write: (handle, buffer, length) => {
                writes += 1;
                return writes === 3 ? rejected('ENOSPC') : machineFileSystemCopier.write(handle, buffer, length);
            },
        });

        const answer = await copied({
            source_directory: source, names: ['a.txt', 'big.bin'], destination_directory: destination,
        }, dependencies({ copier: filling }));

        expect(answer.completed_count).toBe(1);
        expect(failureOf(answer, 'big.bin')!.code).toBe(ERROR_NO_SPACE);
        expect(namesIn(destination)).toEqual(['a.txt']);
    });

    test('an unreadable file inside a tree: the name fails, finished files stay', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const web = makeFolder('src', 'web');
        const unreadable = writeFile(web, 'secret.txt');
        writeFile(web, 'index.html');
        writeFile(source, 'after.txt');
        const failing = copier({
            openToRead: (target) => target === unreadable
                ? rejected('EACCES') : machineFileSystemCopier.openToRead(target),
            readdir: async (folder) => (await machineFileSystemCopier.readdir(folder)).sort(),
        });

        const answer = await copied({
            source_directory: source, names: ['web', 'after.txt'], destination_directory: destination,
        }, dependencies({ copier: failing }));

        expect(answer).toMatchObject({ completed_count: 1, skipped_count: 0, failed_count: 1 });
        expect(failureOf(answer, 'web')!.code).toBe(ERROR_PERMISSION_DENIED);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['index.html']);
        expect(namesIn(destination)).toEqual(['after.txt', 'web']);
    });

    test('a name gone since the request is path_not_found', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');

        const answer = await copied({
            source_directory: source, names: ['gone.txt'], destination_directory: destination,
        });

        expect(failureOf(answer, 'gone.txt')!.code).toBe(ERROR_PATH_NOT_FOUND);
    });

    posixTest('a named pipe is left out: selected, it fails, inside a folder, the rest is copied', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        execFileSync('mkfifo', [path.join(source, 'pipe')]);
        const web = makeFolder('src', 'web');
        writeFile(web, 'index.html');
        execFileSync('mkfifo', [path.join(web, 'pipe')]);

        const answer = await copied({
            source_directory: source, names: ['pipe', 'web'], destination_directory: destination,
        });

        expect(failureOf(answer, 'pipe')).toEqual({
            code: ERROR_SPECIAL_FILE, message: 'This is a socket, pipe or device file. Pinggy cannot copy it.',
        });
        expect(failureOf(answer, 'web')).toEqual({
            code: ERROR_SPECIAL_FILE, message: '1 socket, pipe or device file inside was left out.',
        });
        expect(namesIn(path.join(destination, 'web'))).toEqual(['index.html']);
    });
});

describe('the file channel handler', () => {
    function recordingHandler(handlerDependencies: Partial<ConstructorParameters<typeof FileHandler>[0]> = {}) {
        const sent: Envelope[] = [];
        const handler = new FileHandler({
            send: (frame) => sent.push(frame), protectedSources: sources, hiddenNameSuffix: () => HIDDEN_SUFFIX,
            ...handlerDependencies,
        });
        return { handler, sent };
    }

    function answersIn(sent: Envelope[]): Envelope[] {
        return sent.filter((frame) => frame.kind === 'res');
    }

    function progressIn(sent: Envelope[]): Envelope[] {
        return sent.filter((frame) => frame.kind === 'event' && frame.op === OP_PROGRESS);
    }

    function errorOf(frame: Envelope): FileError['error'] {
        return (frame.payload as FileError).error;
    }

    /** Reads that wait for the test to let each one finish, with the number of bytes it gives. */
    function gatedReads() {
        const gates: Array<(bytesRead: number) => void> = [];
        const read = () => new Promise<number>((resolve) => gates.push(resolve));
        return { read, gates };
    }

    test('refuses a copy until a welcome enables it', async () => {
        const { handler, sent } = recordingHandler();

        await handler.handle(request(CHANNEL_FILE, OP_COPY, {
            source_directory: workDir, names: ['a'], destination_directory: workDir,
        }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });

    test.each([
        ['no names', { source_directory: '/a', names: [], destination_directory: '/b' }],
        ['no destination', { source_directory: '/a', names: ['x'] }],
        ['an unknown on_conflict', {
            source_directory: '/a', names: ['x'], destination_directory: '/b', on_conflict: 'merge',
        }],
    ])('%s is invalid_payload', async (_case, payload) => {
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_COPY, payload));

        expect(errorOf(sent[0]).code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('progress first, on the request id, then the answer on the same id and op', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt', 'abc');
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);
        const asked = request(CHANNEL_FILE, OP_COPY, {
            source_directory: source, names: ['a.txt'], destination_directory: destination,
        });

        await handler.handle(asked);

        expect(sent.map((frame) => frame.kind)).toEqual(['event', 'res']);
        expect(sent[0]).toMatchObject({ ch: CHANNEL_FILE, op: OP_PROGRESS, id: asked.id });
        expect(sent[0].payload).toEqual({
            items_done: 0, items_total: 1, files_done: 0, bytes_done: 0, current_name: 'a.txt',
        });
        expect(sent[1]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_COPY, id: asked.id });
        expect(sent[1].payload).toEqual({ completed_count: 1, skipped_count: 0, failed_count: 0 });
    });

    test('a refusal from the checks sends no progress, and no_space comes after it', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        writeFile(destination, 'a.txt');
        const { handler, sent } = recordingHandler({ copier: copier({ freeBytes: async () => 0n }) });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_COPY, {
            source_directory: source, names: ['a.txt'], destination_directory: destination,
        }));
        await handler.handle(request(CHANNEL_FILE, OP_COPY, {
            source_directory: source, names: ['a.txt'], destination_directory: destination, on_conflict: 'keep_both',
        }));

        expect(sent.map((frame) => frame.kind)).toEqual(['res', 'event', 'res']);
        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_EXISTS);
        expect(errorOf(sent[2]).code).toBe(ERROR_NO_SPACE);
    });

    test('copies and deletes share the slots', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        const { read, gates } = gatedReads();
        const { handler, sent } = recordingHandler({ copier: copier({ read }) });
        handler.configure(true, MAX_FRAME_BYTES, 1);

        const running = handler.handle(request(CHANNEL_FILE, OP_COPY, {
            source_directory: source, names: ['a.txt'], destination_directory: destination,
        }));
        await waitUntil(() => gates.length === 1);
        const deleteAsked = request(CHANNEL_FILE, OP_DELETE, { directory: source, names: ['a.txt'] });
        await handler.handle(deleteAsked);
        gates[0](0);
        await running;

        const busyAnswer = answersIn(sent).find((frame) => frame.id === deleteAsked.id)!;
        expect(errorOf(busyAnswer)).toEqual({
            code: ERROR_FILE_BUSY, message: 'The device is already running 1 file operation.',
        });
        expect(fs.existsSync(path.join(source, 'a.txt'))).toBe(true);
    });

    test('a piece that hangs: file_timeout, and the cut-off file removed', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'big.bin', Buffer.alloc(2 * MEBIBYTE));
        let reads = 0;
        const hanging = copier({
            read: (handle, buffer) => {
                reads += 1;
                return reads === 1 ? machineFileSystemCopier.read(handle, buffer) : new Promise(() => undefined);
            },
        });
        const { handler, sent } = recordingHandler({ copier: hanging, copyCallTimeoutMillis: 100 });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_COPY, {
            source_directory: source, names: ['big.bin'], destination_directory: destination,
        }));

        const answer = answersIn(sent)[0].payload as FileOperationAnswer;
        expect(answer.failed![0].error.code).toBe(ERROR_FILE_TIMEOUT);
        expect(namesIn(destination)).toEqual([]);
    });

    describe('the progress timer', () => {
        beforeEach(() => {
            // The copy's real filesystem calls finish on their own: only the interval is faked.
            jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('the totals once counted, then bytes alone, and none after the answer', async () => {
            const source = makeFolder('src');
            const destination = makeFolder('dest');
            writeFile(source, 'big.bin', '0123456789');
            const { read, gates } = gatedReads();
            const { handler, sent } = recordingHandler({
                copier: copier({ read, write: async () => undefined }),
            });
            handler.configure(true, MAX_FRAME_BYTES, 3);

            const handled = handler.handle(request(CHANNEL_FILE, OP_COPY, {
                source_directory: source, names: ['big.bin'], destination_directory: destination,
            }));
            await waitUntil(() => gates.length === 1);
            expect(progressIn(sent)).toHaveLength(1);
            expect(progressIn(sent)[0].payload).not.toHaveProperty('files_total');

            await jest.advanceTimersByTimeAsync(1000);
            expect(progressIn(sent)).toHaveLength(2);
            expect(progressIn(sent)[1].payload).toMatchObject({ files_total: 1, bytes_total: 10, bytes_done: 0 });

            gates[0](4);
            await waitUntil(() => gates.length === 2);
            await jest.advanceTimersByTimeAsync(1000);
            expect(progressIn(sent)).toHaveLength(3);
            expect(progressIn(sent)[2].payload).toMatchObject({ files_done: 0, bytes_done: 4 });

            gates[1](0);
            await handled;
            const framesAtAnswer = sent.length;
            await jest.advanceTimersByTimeAsync(10_000);

            expect(sent.length).toBe(framesAtAnswer);
            expect(sent[sent.length - 1].kind).toBe('res');
        });
    });
});

/** Waits for a call to be made: the copy reaches it after a few real filesystem calls. */
async function waitUntil(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (!condition()) {
        throw new Error('the condition never held');
    }
}
