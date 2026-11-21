import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_FILE_EXISTS, ERROR_FILE_MANAGER_DISABLED, ERROR_INVALID_DESTINATION,
    ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT, ERROR_NO_SPACE, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED,
    ERROR_PROTECTED_PATH, ERROR_SPECIAL_FILE, FileCopyRequest, FileCopyResult, FileError, FileOperationAnswer,
    FileProgress, OP_COPY, OP_MOVE, OP_PROGRESS,
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
const ROOMY_BUDGET = 1_000_000;
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

async function moveIn(moveRequest: FileCopyRequest, using: CopyDependencies = dependencies(),
                      seen: { progress?: FileProgress } = {}): Promise<FileCopyResult> {
    const prepared = await prepareMove(moveRequest, using, ROOMY_BUDGET);
    if ('error' in prepared) {
        return prepared;
    }
    const progress = moveProgress(prepared);
    seen.progress = progress;
    return runMove(prepared, progress, using, ROOMY_BUDGET);
}

async function moved(moveRequest: FileCopyRequest, using?: CopyDependencies,
                     seen?: { progress?: FileProgress }): Promise<FileOperationAnswer> {
    const result = await moveIn(moveRequest, using, seen);
    if ('error' in result) {
        throw new Error(`Expected an answer, got ${result.error.code}: ${result.error.message}`);
    }
    return result;
}

async function refused(moveRequest: FileCopyRequest, using?: CopyDependencies): Promise<FileError['error']> {
    const result = await moveIn(moveRequest, using);
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

        const answer = await moved({
            source_directory: folder, names: ['notes.txt'], destination_directory: folder, new_name: 'notes-old.txt',
        });

        expect(answer).toEqual({ completed_count: 1, skipped_count: 0, failed_count: 0 });
        expect(namesIn(folder)).toEqual(['notes-old.txt']);
        expect(fs.statSync(path.join(folder, 'notes-old.txt')).ino).toBe(inode);
    });

    test('a rename that changes only the letter case', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'Notes.txt', 'hello');

        const answer = await moved({
            source_directory: folder, names: ['Notes.txt'], destination_directory: folder, new_name: 'notes.txt',
        });

        expect(answer.completed_count).toBe(1);
        expect(namesIn(folder)).toEqual(['notes.txt']);
        expect(textOf(folder, 'notes.txt')).toBe('hello');
    });

    test('several names into another folder: the same files and folders, whole', async () => {
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

        const answer = await moved({ source_directory: source, names, destination_directory: destination },
            undefined, seen);

        expect(answer.completed_count).toBe(names.length);
        expect(namesIn(source)).toEqual([]);
        expect(namesIn(destination)).toEqual(names);
        expect(fs.statSync(path.join(destination, 'web')).ino).toBe(inode);
        expect(textOf(destination, 'web', 'css', 'site.css')).toBe('body {}');
        if (!isWindows) {
            expect(fs.readlinkSync(path.join(destination, 'link'))).toBe('a.txt');
        }
        expect(seen.progress).toMatchObject({
            items_done: names.length, items_total: names.length, files_done: names.length,
            files_total: names.length, bytes_done: 0, bytes_total: 0,
        });
    });

    posixTest('a folder with a named pipe inside moves whole', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const web = makeFolder('src', 'web');
        execFileSync('mkfifo', [path.join(web, 'pipe')]);

        const answer = await moved({ source_directory: source, names: ['web'], destination_directory: destination });

        expect(answer.completed_count).toBe(1);
        expect(fs.lstatSync(path.join(destination, 'web', 'pipe')).isFIFO()).toBe(true);
    });

    test('a name gone since the request is path_not_found', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        const prepared = await prepareMove({
            source_directory: source, names: ['a.txt'], destination_directory: destination,
        }, dependencies(), ROOMY_BUDGET);
        fs.rmSync(path.join(source, 'a.txt'));

        const answer = await runMove(prepared as never, moveProgress(prepared as never), dependencies(),
            ROOMY_BUDGET) as FileOperationAnswer;

        expect(failureOf(answer, 'a.txt')!.code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a file another program holds open, as on Windows: permission_denied, and it stays', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'report.docx');
        const locking = copier({ rename: () => rejected('EBUSY') });

        const answer = await moved({
            source_directory: source, names: ['report.docx'], destination_directory: destination,
        }, dependencies({ copier: locking }));

        expect(failureOf(answer, 'report.docx')!.code).toBe(ERROR_PERMISSION_DENIED);
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

        const answer = await moved({
            source_directory: source, names: ['web'], destination_directory: destination,
        }, dependencies({ copier: bindMounted }), seen);

        expect(answer.completed_count).toBe(1);
        expect(namesIn(source)).toEqual([]);
        expect(namesIn(destination)).toEqual(['web']);
        expect(textOf(destination, 'web', 'index.html')).toBe('12345');
        expect(seen.progress).toMatchObject({ files_done: 2, files_total: 2, bytes_done: 5, bytes_total: 5 });
    });
});

describe('the request', () => {
    test.each([
        ['1 name', ['a.txt'], 'The item is already in this folder.'],
        ['2 names', ['a.txt', 'b.txt'], 'The items are already in this folder.'],
    ])('into its own folder, %s, is invalid_destination', async (_case, names, message) => {
        const folder = makeFolder('src');
        names.forEach((name) => writeFile(folder, name));

        expect(await refused({ source_directory: folder, names, destination_directory: folder }))
            .toEqual({ code: ERROR_INVALID_DESTINATION, message });
        expect(namesIn(folder)).toEqual(names);
    });

    test('a new_name equal to the name is invalid_destination', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'a.txt');

        expect((await refused({
            source_directory: folder, names: ['a.txt'], destination_directory: folder, new_name: 'a.txt',
        })).code).toBe(ERROR_INVALID_DESTINATION);
    });

    test('a folder into a folder inside it is invalid_destination', async () => {
        const source = makeFolder('src');
        const inside = makeFolder('src', 'web', 'old');

        expect(await refused({ source_directory: source, names: ['web'], destination_directory: inside }))
            .toEqual({ code: ERROR_INVALID_DESTINATION, message: 'A folder cannot be moved into itself.' });
        expect(namesIn(source)).toEqual(['web']);
    });

    test('replace of a folder that holds the source is invalid_destination', async () => {
        const downloads = makeFolder('downloads');
        const inner = makeFolder('downloads', 'app', 'app');
        writeFile(inner, 'run.sh');

        expect(await refused({
            source_directory: path.join(downloads, 'app'), names: ['app'], destination_directory: downloads,
            on_conflict: 'replace',
        })).toEqual({ code: ERROR_INVALID_DESTINATION, message: 'An item cannot replace a folder that holds it.' });
        expect(namesIn(inner)).toEqual(['run.sh']);
    });

    test('a new_name with 2 names is invalid_payload', async () => {
        const folder = makeFolder('src');

        expect((await refused({
            source_directory: folder, names: ['a', 'b'], destination_directory: makeFolder('dest'), new_name: 'c',
        })).code).toBe(ERROR_INVALID_PAYLOAD);
    });
});

describe('a protected source', () => {
    test.each([
        ['a system folder', () => workDir, 'system', MESSAGE_SYSTEM_FOLDER],
        ['the folder that holds the config folder', () => sources.home, '.config', MESSAGE_PINGGY_FOLDER],
    ])('%s fails protected_path, stays, and the other names move', async (_case, folderOf, name, message) => {
        const destination = makeFolder('dest');
        writeFile(folderOf(), 'other.txt');

        const answer = await moved({
            source_directory: folderOf(), names: [name, 'other.txt'], destination_directory: destination,
        });

        expect(answer.completed_count).toBe(1);
        expect(failureOf(answer, name)).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(fs.existsSync(path.join(folderOf(), name))).toBe(true);
        expect(namesIn(destination)).toEqual(['other.txt']);
    });

    test.each([
        ['the config folder', () => sources.configFolder, 'device.json', MESSAGE_PINGGY_FOLDER],
        ['the accounts folder', () => sources.accountsFolder, 'bob', MESSAGE_ACCOUNT_FOLDER],
    ])('in %s every name fails protected_path, as for delete', async (_case, folderOf, name, message) => {
        makeFolder('accounts', 'bob');
        const destination = makeFolder('dest');
        writeFile(folderOf(), 'other.txt');

        const answer = await moved({
            source_directory: folderOf(), names: [name, 'other.txt'], destination_directory: destination,
        });

        expect(answer.completed_count).toBe(0);
        expect(failureOf(answer, name)).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(failureOf(answer, 'other.txt')).toEqual({ code: ERROR_PROTECTED_PATH, message });
        expect(namesIn(destination)).toEqual([]);
    });

    test('a selected mounted disk fails mount_point, and stays', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        const usb = makeFolder('src', 'usb');
        const mounted = copier({
            lstat: async (target) => {
                const stats = await machineFileSystemCopier.lstat(target);
                return target === usb ? onDevice(stats, OTHER_DEVICE) : stats;
            },
        });

        const answer = await moved({ source_directory: source, names: ['usb'], destination_directory: destination },
            dependencies({ copier: mounted }));

        expect(failureOf(answer, 'usb')).toEqual({
            code: ERROR_MOUNT_POINT, message: 'This folder is a mounted disk. Open it to move what is inside.',
        });
        expect(namesIn(source)).toEqual(['usb']);
    });
});

describe('a name already taken, on 1 disk', () => {
    function takenSetup() {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt', 'new');
        writeFile(source, 'b.txt', 'new');
        writeFile(destination, 'a.txt', 'old');
        return { source, destination };
    }

    test('fail, the default: file_exists with the clash, and nothing moved', async () => {
        const { source, destination } = takenSetup();

        const error = await refused({ source_directory: source, names: ['a.txt', 'b.txt'],
            destination_directory: destination });

        expect(error).toEqual({
            code: ERROR_FILE_EXISTS, message: '1 item already exists in the destination.', conflict_count: 1,
            conflicts: ['a.txt'],
        });
        expect(namesIn(source)).toEqual(['a.txt', 'b.txt']);
    });

    test('skip leaves the taken name where it was, and moves the rest', async () => {
        const { source, destination } = takenSetup();

        const answer = await moved({ source_directory: source, names: ['a.txt', 'b.txt'],
            destination_directory: destination, on_conflict: 'skip' });

        expect(answer).toEqual({ completed_count: 1, skipped_count: 1, failed_count: 0 });
        expect(namesIn(source)).toEqual(['a.txt']);
        expect(textOf(destination, 'a.txt')).toBe('old');
    });

    test('keep_both takes the first free number', async () => {
        const { source, destination } = takenSetup();
        writeFile(destination, 'a (1).txt', 'older');

        await moved({ source_directory: source, names: ['a.txt'], destination_directory: destination,
            on_conflict: 'keep_both' });

        expect(namesIn(destination)).toEqual(['a (1).txt', 'a (2).txt', 'a.txt']);
        expect(textOf(destination, 'a (2).txt')).toBe('new');
        expect(namesIn(source)).toEqual(['b.txt']);
    });

    test('replace of a file: the moved one in its place, nothing hidden left', async () => {
        const { source, destination } = takenSetup();

        await moved({ source_directory: source, names: ['a.txt'], destination_directory: destination,
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

        const answer = await moved({ source_directory: source, names: ['web'], destination_directory: destination,
            on_conflict: 'replace' });

        expect(answer.completed_count).toBe(1);
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

        const answer = await moved({ source_directory: source, names: ['web'], destination_directory: destination,
            on_conflict: 'replace' }, dependencies({ copier: locking }));

        expect(failureOf(answer, 'web')!.code).toBe(ERROR_PERMISSION_DENIED);
        expect(namesIn(destination)).toEqual(['web']);
        expect(namesIn(path.join(destination, 'web'))).toEqual(['old.html']);
        expect(namesIn(path.join(source, 'web'))).toEqual(['new.html']);
    });

    test('a hard link of the source under another name is a clash, and replace onto it is refused', async () => {
        const folder = makeFolder('src');
        fs.linkSync(writeFile(folder, 'a.txt'), path.join(folder, 'b.txt'));
        const renamed = {
            source_directory: folder, names: ['a.txt'], destination_directory: folder, new_name: 'b.txt',
        };

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

        const moving = moved({ source_directory: source, names: ['photos'], destination_directory: usb }, using,
            seen);
        await waitUntil(() => gates.length === 1);
        expect(namesIn(usb)).toEqual(['.photos.pinggy-move-0badc0de']);
        expect(seen.progress).toMatchObject({ files_total: 2, bytes_total: 5 });
        gates[0](0);
        const answer = await moving;

        expect(answer).toEqual({ completed_count: 1, skipped_count: 0, failed_count: 0 });
        expect(namesIn(usb)).toEqual(['photos']);
        expect(namesIn(path.join(usb, 'photos'))).toEqual(['a.jpg']);
        expect(namesIn(source)).toEqual([]);
    });

    test('the first progress has no totals: they come once counted', () => {
        const progress = moveProgress({
            names: ['photos'], acrossDisks: true,
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

        const answer = await moved({ source_directory: source, names: ['photos'], destination_directory: usb },
            dependencies({ copier: unplugged }));

        expect(failureOf(answer, 'photos')!.code).toBe('file_operation_failed');
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

        const answer = await moved({ source_directory: source, names: ['photos'], destination_directory: usb },
            dependencies({ copier: otherDisk(usb), remover: stuck }));

        const failure = failureOf(answer, 'photos')!;
        expect(failure.code).toBe(ERROR_PERMISSION_DENIED);
        expect(failure.message).toMatch(/^The item is in its new place\. The original could not be fully removed: /);
        expect(namesIn(path.join(usb, 'photos'))).toEqual(['a.jpg']);
        expect(namesIn(path.join(source, 'photos'))).toEqual(['a.jpg']);
    });

    test('no_space: the totals against the free bytes, and nothing moved', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        writeFile(source, 'a.txt', '12345');

        const error = await refused({ source_directory: source, names: ['a.txt'], destination_directory: usb },
            dependencies({ copier: otherDisk(usb, { freeBytes: async () => 2n }) }));

        expect(error).toEqual({
            code: ERROR_NO_SPACE, message: 'The copy needs 5 bytes. The destination disk has 2 bytes free.',
        });
        expect(namesIn(source)).toEqual(['a.txt']);
        expect(namesIn(usb)).toEqual([]);
    });

    test('a mounted disk inside: that name fails before anything is copied, the rest moves', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        const data = makeFolder('src', 'work', 'data');
        writeFile(data, 'big.bin');
        writeFile(source, 'notes.txt');
        const base = otherDisk(usb);
        const mounted = copier({
            ...base,
            lstat: async (target) => {
                const stats = await base.lstat(target);
                return target === data ? onDevice(stats, 7n) : stats;
            },
        });

        const answer = await moved({
            source_directory: source, names: ['work', 'notes.txt'], destination_directory: usb,
        }, dependencies({ copier: mounted }));

        expect(failureOf(answer, 'work')).toEqual({
            code: ERROR_MOUNT_POINT,
            message: 'Another disk is mounted inside. Pinggy does not move it to another disk.',
        });
        expect(answer.completed_count).toBe(1);
        expect(namesIn(usb)).toEqual(['notes.txt']);
        expect(namesIn(data)).toEqual(['big.bin']);
    });

    posixTest('a named pipe: selected, or inside a folder, the name fails and stays', async () => {
        const source = makeFolder('src');
        const usb = makeFolder('usb');
        execFileSync('mkfifo', [path.join(source, 'pipe')]);
        const work = makeFolder('src', 'work');
        writeFile(work, 'a.txt');
        execFileSync('mkfifo', [path.join(work, 'app.sock')]);

        const answer = await moved({ source_directory: source, names: ['pipe', 'work'], destination_directory: usb },
            dependencies({ copier: otherDisk(usb) }));

        expect(failureOf(answer, 'pipe')).toEqual({
            code: ERROR_SPECIAL_FILE,
            message: 'This is a socket, pipe or device file. Pinggy cannot move it to another disk.',
        });
        expect(failureOf(answer, 'work')).toEqual({
            code: ERROR_SPECIAL_FILE,
            message: 'This folder holds 1 socket, pipe or device file, which cannot be moved to another disk.',
        });
        expect(namesIn(usb)).toEqual([]);
        expect(namesIn(work)).toEqual(['a.txt', 'app.sock']);
    });

    test('fail and skip settle a taken name before anything is copied', async () => {
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

        const answer = await moved({ source_directory: source, names: ['a.txt'], destination_directory: usb,
            on_conflict: 'skip' }, dependencies({ copier: counting }));

        expect(answer.skipped_count).toBe(1);
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

        await moved({ source_directory: source, names: ['web'], destination_directory: usb,
            on_conflict: 'replace' }, using);
        await moved({ source_directory: source, names: ['a.txt'], destination_directory: usb,
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

        await moved({ source_directory: source, names: ['run.sh'], destination_directory: usb },
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
            source_directory: workDir, names: ['a'], destination_directory: workDir, new_name: 'b',
        }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });

    test('on 1 disk the first progress holds the totals, then the answer on the same id and op', async () => {
        const source = makeFolder('src');
        const destination = makeFolder('dest');
        writeFile(source, 'a.txt');
        writeFile(source, 'b.txt');
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);
        const asked = request(CHANNEL_FILE, OP_MOVE, {
            source_directory: source, names: ['a.txt', 'b.txt'], destination_directory: destination,
        });

        await handler.handle(asked);

        expect(sent.map((frame) => frame.kind)).toEqual(['event', 'res']);
        expect(sent[0]).toMatchObject({ ch: CHANNEL_FILE, op: OP_PROGRESS, id: asked.id });
        expect(sent[0].payload).toEqual({
            items_done: 0, items_total: 2, files_done: 0, files_total: 2, bytes_done: 0, bytes_total: 0,
            current_name: 'a.txt',
        });
        expect(sent[1]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_MOVE, id: asked.id });
        expect(sent[1].payload).toEqual({ completed_count: 2, skipped_count: 0, failed_count: 0 });
    });

    test('a refusal from the checks sends no progress', async () => {
        const folder = makeFolder('src');
        writeFile(folder, 'a.txt');
        const { handler, sent } = recordingHandler();
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_MOVE, {
            source_directory: folder, names: ['a.txt'], destination_directory: folder,
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
            source_directory: source, names: ['a.txt'], destination_directory: destination,
        }));
        await waitUntil(() => gates.length === 1);
        const renameAsked = request(CHANNEL_FILE, OP_MOVE, {
            source_directory: source, names: ['a.txt'], destination_directory: source, new_name: 'b.txt',
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
