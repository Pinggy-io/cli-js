import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_FILE_EXISTS, ERROR_FILE_MANAGER_DISABLED, ERROR_INVALID_DESTINATION,
    ERROR_INVALID_NAME, ERROR_INVALID_PATH, ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT, ERROR_NO_SPACE,
    ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH, ERROR_SPECIAL_FILE, FileCopyRequest,
    FileCopyResult, FileError, FileProgress, OP_COPY, OP_MOVE, OP_PROGRESS,
} from '../devices/files/file_schema.js';
import { CopyDependencies } from '../devices/files/fileCopy.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import { moveProgress, prepareMove, runMove } from '../devices/files/fileMove.js';
import {
    MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, MESSAGE_SYSTEM_FOLDER, ProtectedSources,
} from '../devices/files/fileProtectedPaths.js';
import {
    FileSystemCopier, FileSystemRemover, machineFileSystemCopier, machineFileSystemRemover,
} from '../devices/files/fileSystem.js';

/**
 * `file/move`, against a real temp folder. What the OS cannot be made to do on demand is faked: another disk, by
 * a copier that reports the destination folder on another device; a mounted disk; a refused rename; a full disk.
 *
 * Every protected path points into the temp folder. No test moves a real system folder.
 */

const MAX_FRAME_BYTES = 32768;
const CALL_TIMEOUT_MILLIS = 2_000;
const HIDDEN_SUFFIX = '0badc0de';
const OTHER_DEVICE = 999_999n;
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** Named pipes do not exist on Windows. */
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

/** The same stats on another device, as a mounted disk would report. */
function onDevice(stats: fs.BigIntStats, device: bigint): fs.BigIntStats {
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: device });
}

function isInside(target: string, folder: string): boolean {
    return target === folder || target.startsWith(folder + path.sep);
}

/** `folder` and all in it on another device: a move into it runs as a move to another disk. */
function otherDisk(folder: string, overrides: Partial<FileSystemCopier> = {}): FileSystemCopier {
    const moved = (stats: fs.BigIntStats, target: string) => isInside(target, folder)
        ? onDevice(stats, OTHER_DEVICE) : stats;
    return copier({
        stat: async (target) => moved(await machineFileSystemCopier.stat(target), target),
        lstat: async (target) => moved(await machineFileSystemCopier.lstat(target), target),
        ...overrides,
    });
}

/** The 2 paths for `name` in `sourceFolder`, moved into `destinationFolder` as `targetName`. */
function item(sourceFolder: string, name: string, destinationFolder: string, targetName = name):
    Pick<FileCopyRequest, 'source_path' | 'destination_path'> {
    return { source_path: path.join(sourceFolder, name), destination_path: path.join(destinationFolder, targetName) };
}

async function moveIn(moveRequest: FileCopyRequest, using: CopyDependencies = dependencies(),
                      seen: { progress?: FileProgress } = {}): Promise<FileCopyResult> {
    const prepared = await prepareMove(moveRequest, using);
    if ('error' in prepared) {
        return prepared;
    }
    const progress = moveProgress(prepared);
    seen.progress = progress;
    return runMove(prepared, progress, using);
}

async function moved(moveRequest: FileCopyRequest, using?: CopyDependencies,
                     seen?: { progress?: FileProgress }): Promise<void> {
    expect(await moveIn(moveRequest, using, seen)).toEqual({});
}

async function refused(moveRequest: FileCopyRequest, using?: CopyDependencies): Promise<FileError['error']> {
    const result = await moveIn(moveRequest, using);
    if (!('error' in result)) {
        throw new Error(`Expected an error, got ${JSON.stringify(result)}`);
    }
    return result.error;
}

function rejected(code: string, message = `${code}: fake`): Promise<never> {
    return Promise.reject(Object.assign(new Error(message), { code }));
}

function namesIn(folder: string): string[] {
    return fs.readdirSync(folder).sort();
}

function textOf(...parts: string[]): string {
    return fs.readFileSync(path.join(...parts), 'utf8');
}

async function waitUntil(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (!condition()) {
        throw new Error('the condition never held');
    }
}

/** Reads that wait for the test to let each one finish, with the number of bytes it gives. */
function gatedReads() {
    const gates: Array<(bytesRead: number) => void> = [];
    const read = () => new Promise<number>((resolve) => gates.push(resolve));
    return { read, gates };
}

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-move-'));
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

describe('on 1 disk', () => {
    test('a rename: the same file under its new name', async () => {
        const folder = makeFolder('src');
        const file = writeFile(folder, 'notes.txt', 'hello');
        const inode = fs.statSync(file).ino;

        await moved({
            ...item(folder, 'notes.txt', folder, 'notes-old.txt'),
        });

        expect(namesIn(folder)).toEqual(['notes-old.txt']);
        expect(fs.statSync(path.join(folder, 'notes-old.txt')).ino).toBe(inode);
    });

    test('a rename that changes only the letter case', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'Notes.txt', 'hello');

        await moved({
            ...item(folder, 'Notes.txt', folder, 'notes.txt'),
        });

        expect(namesIn(folder)).toEqual(['notes.txt']);
        expect(textOf(folder, 'notes.txt')).toBe('hello');
    });

    test('into another folder: the same file, folder and link, whole', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('archive');
        writeFile(source, 'a.txt');
        writeFile(makeFolder('src', 'web', 'css'), 'site.css', 'body {}');
        if (!isWindows) {
            fs.symlinkSync('a.txt', path.join(source, 'link'));
        }
        const inode = fs.statSync(path.join(source, 'web')).ino;
        const names = isWindows ? ['a.txt', 'web'] : ['a.txt', 'link', 'web'];
        const seen: { progress?: FileProgress } = {};

        for (const name of names) {
            await moved(item(source, name, destination), undefined, seen);
        }

        expect(namesIn(source)).toEqual([]);
        expect(namesIn(destination)).toEqual(names);
        expect(fs.statSync(path.join(destination, 'web')).ino).toBe(inode);
        expect(textOf(destination, 'web', 'css', 'site.css')).toBe('body {}');
        if (!isWindows) {
            expect(fs.readlinkSync(path.join(destination, 'link'))).toBe('a.txt');
        }
        expect(seen.progress).toEqual({
            items_done: 1, items_total: 1, files_done: 1, files_total: 1, bytes_done: 0, bytes_total: 0,
            current_name: 'web',
        });
    });

    posixTest('a folder with a named pipe inside moves whole', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const web = makeFolder('src', 'web');
        execFileSync('mkfifo', [path.join(web, 'pipe')]);

        await moved({ ...item(source, 'web', destination) });

        expect(fs.lstatSync(path.join(destination, 'web', 'pipe')).isFIFO()).toBe(true);
    });

    test('a source gone between the checks and the move is path_not_found', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        const prepared = await prepareMove(item(source, 'a.txt', destination), dependencies());
        fs.rmSync(path.join(source, 'a.txt'));

        const answer = await runMove(prepared as never, moveProgress(prepared as never), dependencies());

        expect((answer as FileError).error.code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a file another program holds open, as on Windows: permission_denied, and it stays', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'report.docx');
        const locking = copier({ rename: () => rejected('EBUSY') });

        const error = await refused({
            ...item(source, 'report.docx', destination),
        }, dependencies({ copier: locking }));

        expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        expect(namesIn(source)).toEqual(['report.docx']);
    });

    test('a rename that answers EXDEV on 1 device is copied, then removed', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'index.html', '12345');
        const bindMounted = copier({
            rename: (from, to) => isInside(from, source) ? rejected('EXDEV') : machineFileSystemCopier.rename(from, to),
        });
        const seen: { progress?: FileProgress } = {};

        await moved({
            ...item(source, 'web', destination),
        }, dependencies({ copier: bindMounted }), seen);

        expect(namesIn(source)).toEqual([]);
        expect(namesIn(destination)).toEqual(['web']);
        expect(textOf(destination, 'web', 'index.html')).toBe('12345');
        expect(seen.progress).toMatchObject({ files_done: 2, files_total: 2, bytes_done: 5, bytes_total: 5 });
    });
});

describe('the request', () => {
    test('to its own path is invalid_destination', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'a.txt');

        expect(await refused(item(folder, 'a.txt', folder)))
            .toEqual({ code: ERROR_INVALID_DESTINATION, message: 'The item is already in this folder.' });
        expect(namesIn(folder)).toEqual(['a.txt']);
    });

    test('a folder into a folder inside it is invalid_destination', async () => {
        const source = makeFolder('src');
        const inside = makeFolder('src', 'web', 'old');

        expect(await refused(item(source, 'web', inside)))
            .toEqual({ code: ERROR_INVALID_DESTINATION, message: 'A folder cannot be moved into itself.' });
        expect(namesIn(source)).toEqual(['web']);
    });

    test('replace of a folder that holds the source is invalid_destination', async () => {
        const downloads = makeFolder('downloads');
        const inner = makeFolder('downloads', 'app', 'app');
        writeFile(inner, 'run.sh');

        expect(await refused({ ...item(path.join(downloads, 'app'), 'app', downloads), on_conflict: 'replace' }))
            .toEqual({ code: ERROR_INVALID_DESTINATION, message: 'An item cannot replace a folder that holds it.' });
        expect(namesIn(inner)).toEqual(['run.sh']);
    });

    test('a root as either path is invalid_path, and nothing moves', async () => {
        const root = path.parse(workDir).root;
        const file = writeFile(makeFolder('src'), 'a.txt');
        const message = 'A drive or filesystem root cannot be copied or moved.';

        const fromRoot = await refused({ source_path: root, destination_path: path.join(workDir, 'root') });
        const ontoRoot = await refused({ source_path: file, destination_path: root, on_conflict: 'replace' });

        expect(fromRoot).toEqual({ code: ERROR_INVALID_PATH, message });
        expect(ontoRoot).toEqual({ code: ERROR_INVALID_PATH, message });
        expect(fs.existsSync(file)).toBe(true);
    });

    test('a last part of 256 bytes is invalid_payload, and one Windows refuses is invalid_name there', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'a.txt');

        const long = await refused(item(folder, 'a.txt', folder, 'n'.repeat(256)));
        const windows = await refused({ source_path: 'C:\\data\\a.txt', destination_path: 'C:\\data\\CON' },
            dependencies({ platform: 'win32' }));

        expect(long).toEqual({ code: ERROR_INVALID_PAYLOAD, message: 'A name is longer than 255 bytes.' });
        expect(windows).toEqual({ code: ERROR_INVALID_NAME, message: 'CON is a device name on Windows.' });
        expect(namesIn(folder)).toEqual(['a.txt']);
    });

    test('a source that is gone is path_not_found', async () => {
        const folder = makeFolder('src');

        expect((await refused(item(folder, 'gone.txt', makeFolder('dest')))).code).toBe(ERROR_PATH_NOT_FOUND);
    });
});

describe('a protected source', () => {
    test.each([
        ['a system folder', () => workDir, 'system', MESSAGE_SYSTEM_FOLDER],
        ['the folder that holds the config folder', () => sources.home, '.config', MESSAGE_PINGGY_FOLDER],
    ])('%s is protected_path, stays, and a file beside it moves', async (_case, folderOf, name, message) => {
        const destination = makeFolder('dest');
        writeFile(folderOf(), 'other.txt');

        const error = await refused(item(folderOf(), name, destination));
        await moved(item(folderOf(), 'other.txt', destination));

        expect(error).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(fs.existsSync(path.join(folderOf(), name))).toBe(true);
        expect(namesIn(destination)).toEqual(['other.txt']);
    });

    test.each([
        ['the config folder', () => sources.configFolder, 'device.json', MESSAGE_PINGGY_FOLDER],
        ['the accounts folder', () => sources.accountsFolder, 'bob', MESSAGE_ACCOUNT_FOLDER],
    ])('in %s every item is protected_path, as for delete', async (_case, folderOf, name, message) => {
        makeFolder('accounts', 'bob');
        const destination = makeFolder('dest');
        writeFile(folderOf(), 'other.txt');

        const named = await refused(item(folderOf(), name, destination));
        const other = await refused(item(folderOf(), 'other.txt', destination));

        expect(named).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(other).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(namesIn(destination)).toEqual([]);
    });

    test('a mounted disk asked for is mount_point, and stays', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const usb = makeFolder('src', 'usb');
        const mounted = copier({
            lstat: async (target) => {
                const stats = await machineFileSystemCopier.lstat(target);
                return target === usb ? onDevice(stats, OTHER_DEVICE) : stats;
            },
        });

        const error = await refused({ ...item(source, 'usb', destination) },
            dependencies({ copier: mounted }));

        expect(error).toEqual({
            code: ERROR_MOUNT_POINT, message: 'This folder is a mounted disk. Open it to move what is inside.',
        });
        expect(namesIn(source)).toEqual(['usb']);
    });
});

describe('a target already taken, on 1 disk', () => {
    function takenSetup() {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt', 'new');
        writeFile(source, 'b.txt', 'new');
        writeFile(destination, 'a.txt', 'old');
        return { source, destination };
    }

    test('fail, the default: file_exists, and nothing moved', async () => {
        const { source, destination } = takenSetup();

        const error = await refused(item(source, 'a.txt', destination));

        expect(error).toEqual({ code: ERROR_FILE_EXISTS, message: '1 item already exists in the destination.' });
        expect(namesIn(source)).toEqual(['a.txt', 'b.txt']);
        expect(textOf(destination, 'a.txt')).toBe('old');
    });

    test('skip leaves a taken target alone and answers skipped, and a free one moves', async () => {
        const { source, destination } = takenSetup();

        const skipped = await moveIn({ ...item(source, 'a.txt', destination), on_conflict: 'skip' });
        await moved({ ...item(source, 'b.txt', destination), on_conflict: 'skip' });

        expect(skipped).toEqual({ skipped: true });
        expect(namesIn(source)).toEqual(['a.txt']);
        expect(textOf(destination, 'a.txt')).toBe('old');
    });

    test('keep_both takes the first free number', async () => {
        const { source, destination } = takenSetup();
        writeFile(destination, 'a (1).txt', 'older');

        await moved({ ...item(source, 'a.txt', destination),
            on_conflict: 'keep_both' });

        expect(namesIn(destination)).toEqual(['a (1).txt', 'a (2).txt', 'a.txt']);
        expect(textOf(destination, 'a (2).txt')).toBe('new');
        expect(namesIn(source)).toEqual(['b.txt']);
    });

    test('replace of a file: the moved one in its place, nothing hidden left', async () => {
        const { source, destination } = takenSetup();

        await moved({ ...item(source, 'a.txt', destination),
            on_conflict: 'replace' });

        expect(namesIn(destination)).toEqual(['a.txt']);
        expect(textOf(destination, 'a.txt')).toBe('new');
        expect(namesIn(source)).toEqual(['b.txt']);
    });

    test('replace of a folder: the old one gone whole, the moved one in its place', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'new.html');
        writeFile(makeFolder('dest', 'web', 'deep'), 'old.html');

        await moved({ ...item(source, 'web', destination),
            on_conflict: 'replace' });

        expect(namesIn(destination)).toEqual(['web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['new.html']);
        expect(namesIn(source)).toEqual([]);
    });

    test('a refused rename during replace puts the old one back', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(makeFolder('src', 'web'), 'new.html');
        writeFile(makeFolder('dest', 'web'), 'old.html');
        const locking = copier({
            rename: (from, to) => isInside(from, source) ? rejected('EPERM') : machineFileSystemCopier.rename(from, to),
        });

        const error = await refused({ ...item(source, 'web', destination),
            on_conflict: 'replace' }, dependencies({ copier: locking }));

        expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        expect(namesIn(destination)).toEqual(['web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['old.html']);
        expect(namesIn(path.join(source, 'web'))).toEqual(['new.html']);
    });

    test('a hard link of the source under another name is a clash, and replace onto it is refused', async () => {
        const folder = makeFolder('src');
        fs.linkSync(writeFile(folder, 'a.txt'), path.join(folder, 'b.txt'));
        const renamed = item(folder, 'a.txt', folder, 'b.txt');

        expect((await refused(renamed)).code).toBe(ERROR_FILE_EXISTS);
        expect(await refused({ ...renamed, on_conflict: 'replace' }))
            .toEqual({ code: ERROR_INVALID_DESTINATION, message: 'An item cannot replace itself.' });
        expect(namesIn(folder)).toEqual(['a.txt', 'b.txt']);
    });
});

describe('to another disk', () => {
    test('copied to a hidden name, put in place once whole, then the original removed', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        writeFile(makeFolder('src', 'photos'), 'a.jpg', '12345');
        const { read, gates } = gatedReads();
        const using = dependencies({ copier: otherDisk(usb, { read }) });
        const seen: { progress?: FileProgress } = {};

        const moving = moved({ ...item(source, 'photos', usb) }, using,
            seen);
        await waitUntil(() => gates.length === 1);
        expect(namesIn(usb)).toEqual(['.photos.pinggy-move-0badc0de']);
        expect(seen.progress).toMatchObject({ files_total: 2, bytes_total: 5 });
        gates[0](0);
        await moving;

        expect(namesIn(usb)).toEqual(['photos']);
        expect(namesIn(path.join(usb, 'photos'))).toEqual(['a.jpg']);
        expect(namesIn(source)).toEqual([]);
    });

    test('the first progress has no totals: they come once counted', () => {
        const progress = moveProgress({
            sourceName: 'photos', acrossDisks: true,
        } as Parameters<typeof moveProgress>[0]);

        expect(progress).toEqual({ items_done: 0, items_total: 1, files_done: 0, bytes_done: 0,
            current_name: 'photos' });
    });

    test('a copy that fails is removed, and the original stays whole', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        const photos = makeFolder('src', 'photos');
        writeFile(photos, 'a.jpg');
        writeFile(photos, 'b.jpg');
        let opened = 0;
        const unplugged = otherDisk(usb, {
            openToRead: (target) => {
                opened += 1;
                return opened === 2 ? rejected('EIO') : machineFileSystemCopier.openToRead(target);
            },
        });

        const error = await refused({ ...item(source, 'photos', usb) },
            dependencies({ copier: unplugged }));

        expect(error.code).toBe('file_operation_failed');
        expect(namesIn(usb)).toEqual([]);
        expect(namesIn(photos)).toEqual(['a.jpg', 'b.jpg']);
    });

    test('an original that cannot be fully removed: the item is in place, and the message says so', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        writeFile(makeFolder('src', 'photos'), 'a.jpg');
        const stuck = remover({
            unlink: (target) => isInside(target, source) ? rejected('EACCES') : machineFileSystemRemover.unlink(target),
        });

        const error = await refused({ ...item(source, 'photos', usb) },
            dependencies({ copier: otherDisk(usb), remover: stuck }));

        expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        expect(error.message).toMatch(/^The item is in its new place\. The original could not be fully removed: /);
        expect(namesIn(path.join(usb, 'photos'))).toEqual(['a.jpg']);
        expect(namesIn(path.join(source, 'photos'))).toEqual(['a.jpg']);
    });

    test('no_space: the totals against the free bytes, and nothing moved', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        writeFile(source, 'a.txt', '12345');

        const error = await refused({ ...item(source, 'a.txt', usb) },
            dependencies({ copier: otherDisk(usb, { freeBytes: async () => 2n }) }));

        expect(error).toEqual({
            code: ERROR_NO_SPACE, message: 'The copy needs 5 bytes. The destination disk has 2 bytes free.',
        });
        expect(namesIn(source)).toEqual(['a.txt']);
        expect(namesIn(usb)).toEqual([]);
    });

    test('a mounted disk inside: the move fails before anything is copied', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        const data = makeFolder('src', 'work', 'data');
        writeFile(data, 'big.bin');
        const base = otherDisk(usb);
        const mounted = copier({
            ...base,
            lstat: async (target) => {
                const stats = await base.lstat(target);
                return target === data ? onDevice(stats, 7n) : stats;
            },
        });

        const error = await refused(item(source, 'work', usb), dependencies({ copier: mounted }));

        expect(error).toEqual({
            code: ERROR_MOUNT_POINT,
            message: 'Another disk is mounted inside. Pinggy does not move it to another disk.',
        });
        expect(namesIn(usb)).toEqual([]);
        expect(namesIn(data)).toEqual(['big.bin']);
    });

    posixTest('a named pipe: asked for, or inside a folder, the move fails and it stays', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        execFileSync('mkfifo', [path.join(source, 'pipe')]);
        const work = makeFolder('src', 'work');
        writeFile(work, 'a.txt');
        execFileSync('mkfifo', [path.join(work, 'app.sock')]);

        const using = dependencies({ copier: otherDisk(usb) });
        const selected = await refused(item(source, 'pipe', usb), using);
        const inside = await refused(item(source, 'work', usb), using);

        expect(selected).toEqual({
            code: ERROR_SPECIAL_FILE,
            message: 'This is a socket, pipe or device file. Pinggy cannot move it to another disk.',
        });
        expect(inside).toEqual({
            code: ERROR_SPECIAL_FILE,
            message: 'This folder holds 1 socket, pipe or device file, which cannot be moved to another disk.',
        });
        expect(namesIn(usb)).toEqual([]);
        expect(namesIn(work)).toEqual(['a.txt', 'app.sock']);
    });

    test('fail and skip settle a taken target before anything is copied', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        writeFile(source, 'a.txt', 'new');
        writeFile(usb, 'a.txt', 'old');
        let reads = 0;
        const counting = otherDisk(usb, {
            read: (handle, buffer) => {
                reads += 1;
                return machineFileSystemCopier.read(handle, buffer);
            },
        });

        const answer = await moveIn({ ...item(source, 'a.txt', usb), on_conflict: 'skip' },
            dependencies({ copier: counting }));

        expect(answer).toEqual({ skipped: true });
        expect(reads).toBe(0);
        expect(namesIn(usb)).toEqual(['a.txt']);
        expect(namesIn(source)).toEqual(['a.txt']);
    });

    test('keep_both and replace', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        writeFile(makeFolder('src', 'web'), 'new.html');
        writeFile(source, 'a.txt', 'new');
        writeFile(makeFolder('usb', 'web'), 'old.html');
        writeFile(usb, 'a.txt', 'old');
        const using = dependencies({ copier: otherDisk(usb) });

        await moved({ ...item(source, 'web', usb),
            on_conflict: 'replace' }, using);
        await moved({ ...item(source, 'a.txt', usb),
            on_conflict: 'keep_both' }, using);

        expect(namesIn(usb)).toEqual(['a (1).txt', 'a.txt', 'web']);
        expect(namesIn(path.join(usb, 'web'))).toEqual(['new.html']);
        expect(textOf(usb, 'a (1).txt')).toBe('new');
        expect(namesIn(source)).toEqual([]);
    });

    permissionTest('the permission bits stay', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        fs.chmodSync(writeFile(source, 'run.sh'), 0o750);

        await moved({ ...item(source, 'run.sh', usb) },
            dependencies({ copier: otherDisk(usb) }));

        expect(fs.statSync(path.join(usb, 'run.sh')).mode & 0o777).toBe(0o750);
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

    function errorOf(frame: Envelope): FileError['error'] {
        return (frame.payload as FileError).error;
    }

    test('refuses a move until a welcome enables it', async () => {
        const { handler, sent } = recordingHandler();

        await handler.handle(request(CHANNEL_FILE, OP_MOVE, {
            ...item(workDir, 'a', workDir, 'b'),
        }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });

    test('on 1 disk the first progress holds the totals, then the answer on the same id and op', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);
        const asked = request(CHANNEL_FILE, OP_MOVE, item(source, 'a.txt', destination));

        await handler.handle(asked);

        expect(sent.map((frame) => frame.kind)).toEqual(['event', 'res']);
        expect(sent[0]).toMatchObject({ ch: CHANNEL_FILE, op: OP_PROGRESS, id: asked.id });
        expect(sent[0].payload).toEqual({
            items_done: 0, items_total: 1, files_done: 0, files_total: 1, bytes_done: 0, bytes_total: 0,
            current_name: 'a.txt',
        });
        expect(sent[1]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_MOVE, id: asked.id });
        expect(sent[1].payload).toEqual({});
    });

    test.each([
        ['no source', { destination_path: '/b/x' }],
        ['a destination that is not text', { source_path: '/a/x', destination_path: ['/b/x'] }],
        ['the old fields', { source_directory: '/a', names: ['x'], destination_directory: '/a', new_name: 'y' }],
    ])('%s is invalid_payload', async (_case, payload) => {
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_MOVE, payload));

        expect(errorOf(sent[0]).code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('a refusal from the checks sends no progress', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'a.txt');
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_MOVE, {
            ...item(folder, 'a.txt', folder),
        }));

        expect(sent.map((frame) => frame.kind)).toEqual(['res']);
        expect(errorOf(sent[0]).code).toBe(ERROR_INVALID_DESTINATION);
    });

    test('a rename takes a slot, shared with copies', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        const { read, gates } = gatedReads();
        const { handler, sent } = recordingHandler({ copier: copier({ read }) });
        handler.configure(true, MAX_FRAME_BYTES, 1);

        const running = handler.handle(request(CHANNEL_FILE, OP_COPY, {
            ...item(source, 'a.txt', destination),
        }));
        await waitUntil(() => gates.length === 1);
        const renameAsked = request(CHANNEL_FILE, OP_MOVE, {
            ...item(source, 'a.txt', source, 'b.txt'),
        });
        await handler.handle(renameAsked);
        gates[0](0);
        await running;

        const busyAnswer = sent.find((frame) => frame.kind === 'res' && frame.id === renameAsked.id)!;
        expect(errorOf(busyAnswer)).toEqual({
            code: ERROR_FILE_BUSY, message: 'The device is already running 1 file operation.',
        });
        expect(namesIn(source)).toEqual(['a.txt']);
    });
});
