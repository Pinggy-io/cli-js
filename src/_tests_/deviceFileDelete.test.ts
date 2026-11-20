import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH,
    ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED,
    ERROR_PROTECTED_PATH, FileDeleteResult, FileError, FileOperationAnswer, FileProgress, OP_DELETE, OP_PROGRESS,
} from '../devices/files/file_schema.js';
import { DeleteDependencies, prepareDelete, runDelete } from '../devices/files/fileDelete.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import {
    MESSAGE_PINGGY_FOLDER, MESSAGE_SYSTEM_FOLDER, ProtectedSources, selfAndAncestors, systemFoldersFor,
} from '../devices/files/fileProtectedPaths.js';
import { FileSystemRemover, machineFileSystem, machineFileSystemRemover } from '../devices/files/fileSystem.js';

/**
 * `file/delete`, against a real temp folder where the OS allows it, and a fake filesystem for what the
 * OS cannot be made to do on demand: a mounted disk, a bind mount of home, a call that never returns,
 * Windows' read-only retry, and the progress timer.
 *
 * Every protected path points into the temp folder. No test points a delete at a real system folder.
 */

const MAX_FRAME_BYTES = 32768;
const ROOMY_BUDGET = 1_000_000;
const CALL_TIMEOUT_MILLIS = 2_000;
const MOUNTED_DEVICE = 999_999n;
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** Symlinks need a privilege on Windows, and `chmod` checks nothing as root or on Windows. */
const posixTest = isWindows ? test.skip : test;
const permissionTest = isWindows || isRoot ? test.skip : test;

let workDir: string;
let sources: ProtectedSources;

function makeFolder(...parts: string[]): string {
    const folder = path.join(workDir, ...parts);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function writeFile(folder: string, name: string): string {
    const target = path.join(folder, name);
    fs.writeFileSync(target, 'a');
    return target;
}

function remover(overrides: Partial<FileSystemRemover> = {}): FileSystemRemover {
    return { ...machineFileSystemRemover, ...overrides };
}

function dependencies(overrides: Partial<DeleteDependencies> = {}): DeleteDependencies {
    return {
        remover: machineFileSystemRemover,
        platform: process.platform,
        protectedSources: sources,
        callTimeoutMillis: CALL_TIMEOUT_MILLIS,
        ...overrides,
    };
}

function newProgress(): FileProgress {
    return { items_done: 0, items_total: 0, files_done: 0, current_name: '' };
}

async function deleteIn(directory: string, names: string[], using: DeleteDependencies = dependencies(),
                        progress: FileProgress = newProgress(), budget = ROOMY_BUDGET): Promise<FileDeleteResult> {
    const prepared = await prepareDelete({ directory, names }, using);
    if ('error' in prepared) {
        return prepared;
    }
    progress.items_total = names.length;
    return runDelete(prepared, progress, using, budget);
}

async function deleted(directory: string, names: string[], using?: DeleteDependencies,
                       progress?: FileProgress): Promise<FileOperationAnswer> {
    const result = await deleteIn(directory, names, using, progress);
    if ('error' in result) {
        throw new Error(`Expected an answer, got ${result.error.code}: ${result.error.message}`);
    }
    return result;
}

async function refused(directory: string, names: string[], using?: DeleteDependencies):
    Promise<FileError['error']> {
    const result = await deleteIn(directory, names, using);
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

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-delete-'));
    const home = makeFolder('home');
    const configFolder = makeFolder('home', '.config', 'pinggy');
    writeFile(configFolder, 'device.json');
    makeFolder('home', '.config', 'pinggy', 'tunnels');
    sources = { home, configFolder, systemFolders: [makeFolder('system')] };
});

afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('deleting', () => {
    test('1 file', async () => {
        const folder = makeFolder('one');
        const file = writeFile(folder, 'notes.txt');
        const progress = newProgress();

        const answer = await deleted(folder, ['notes.txt'], dependencies(), progress);

        expect(answer).toEqual({ completed_count: 1, failed_count: 0 });
        expect(fs.existsSync(file)).toBe(false);
        expect(progress).toMatchObject({ items_done: 1, files_done: 1, current_name: 'notes.txt' });
    });

    test('a tree, with every file and folder in it counted', async () => {
        const folder = makeFolder('tree-parent');
        const tree = makeFolder('tree-parent', 'tree');
        writeFile(tree, 'a.txt');
        writeFile(makeFolder('tree-parent', 'tree', 'sub'), 'b.txt');
        writeFile(makeFolder('tree-parent', 'tree', 'sub', 'deeper'), 'c.txt');
        const progress = newProgress();

        const answer = await deleted(folder, ['tree'], dependencies(), progress);

        expect(answer).toEqual({ completed_count: 1, failed_count: 0 });
        expect(fs.existsSync(tree)).toBe(false);
        // 3 files and 3 folders.
        expect(progress.files_done).toBe(6);
    });

    test('an empty folder goes with 1 rmdir', async () => {
        const folder = makeFolder('empty-parent');
        makeFolder('empty-parent', 'empty');
        const progress = newProgress();

        await deleted(folder, ['empty'], dependencies(), progress);

        expect(fs.existsSync(path.join(folder, 'empty'))).toBe(false);
        expect(progress.files_done).toBe(1);
    });

    test('several names, in order', async () => {
        const folder = makeFolder('several');
        writeFile(folder, 'a.txt');
        writeFile(makeFolder('several', 'b'), 'inner.txt');
        writeFile(folder, 'c.txt');
        writeFile(folder, 'kept.txt');
        const progress = newProgress();

        const answer = await deleted(folder, ['a.txt', 'b', 'c.txt'], dependencies(), progress);

        expect(answer).toEqual({ completed_count: 3, failed_count: 0 });
        expect(fs.readdirSync(folder)).toEqual(['kept.txt']);
        expect(progress).toMatchObject({ items_done: 3, current_name: 'c.txt' });
    });

    posixTest('a symlink: the link goes, the file and the folder it points at stay', async () => {
        const folder = makeFolder('links');
        const target = writeFile(makeFolder('target'), 'kept.txt');
        fs.symlinkSync(target, path.join(folder, 'to-file'));
        fs.symlinkSync(path.dirname(target), path.join(folder, 'to-folder'));

        const answer = await deleted(folder, ['to-file', 'to-folder']);

        expect(answer).toEqual({ completed_count: 2, failed_count: 0 });
        expect(fs.readdirSync(folder)).toEqual([]);
        expect(fs.existsSync(target)).toBe(true);
    });

    posixTest('a symlink inside a tree is removed, not followed', async () => {
        const folder = makeFolder('tree-with-link');
        const tree = makeFolder('tree-with-link', 'tree');
        const target = writeFile(makeFolder('outside'), 'kept.txt');
        fs.symlinkSync(path.dirname(target), path.join(tree, 'outside-link'));

        await deleted(folder, ['tree']);

        expect(fs.existsSync(tree)).toBe(false);
        expect(fs.existsSync(target)).toBe(true);
    });
});

describe('the request', () => {
    test.each([
        ['an empty name', ''],
        ['a name over 255 bytes', 'a'.repeat(256)],
        ['.', '.'],
        ['..', '..'],
        ['a separator', 'a/b'],
        ['a NUL byte', 'a\0b'],
    ])('%s is invalid_payload, and nothing is deleted', async (_case, name) => {
        const folder = makeFolder('names');
        const kept = writeFile(folder, 'kept.txt');

        const error = await refused(folder, ['kept.txt', name]);

        expect(error.code).toBe(ERROR_INVALID_PAYLOAD);
        expect(fs.existsSync(kept)).toBe(true);
    });

    test('a name listed twice is invalid_payload', async () => {
        const folder = makeFolder('twice');
        writeFile(folder, 'a.txt');

        expect((await refused(folder, ['a.txt', 'a.txt'])).code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('a 255-byte name is allowed', async () => {
        const folder = makeFolder('long-name');
        const name = 'a'.repeat(255);
        writeFile(folder, name);

        expect(await deleted(folder, [name])).toEqual({ completed_count: 1, failed_count: 0 });
    });

    test('\\ is a separator on Windows only', async () => {
        const windows = dependencies({ platform: 'win32' });

        expect((await refused('C:\\data', ['a\\b'], windows)).code).toBe(ERROR_INVALID_PAYLOAD);
        // On Linux and macOS it is an ordinary character, so the name gets as far as the delete.
        const folder = makeFolder('backslash');
        const answer = await deleted(folder, ['a\\b']);
        expect(failureOf(answer, 'a\\b')?.code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a relative directory is invalid_path', async () => {
        expect((await refused('relative/folder', ['a.txt'])).code).toBe(ERROR_INVALID_PATH);
    });

    test('a missing directory is path_not_found', async () => {
        expect((await refused(path.join(workDir, 'gone'), ['a.txt'])).code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a directory that is a file is not_a_directory, and the file stays', async () => {
        const file = writeFile(makeFolder('not-folder'), 'plain.txt');

        expect((await refused(file, ['x'])).code).toBe(ERROR_NOT_A_DIRECTORY);
        expect(fs.existsSync(file)).toBe(true);
    });
});

describe('protected folders', () => {
    test('the home folder itself', async () => {
        const answer = await deleted(workDir, ['home']);

        expect(failureOf(answer, 'home')).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER });
        expect(fs.existsSync(sources.home)).toBe(true);
    });

    test('a folder above the config folder, while the other names go', async () => {
        const home = sources.home;
        const tmp = writeFile(home, 'tmp.txt');

        const answer = await deleted(home, ['.config', 'tmp.txt']);

        expect(answer.completed_count).toBe(1);
        expect(failureOf(answer, '.config')?.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(tmp)).toBe(false);
        expect(fs.existsSync(path.join(sources.configFolder, 'device.json'))).toBe(true);
    });

    test('the config folder', async () => {
        const answer = await deleted(path.dirname(sources.configFolder), ['pinggy']);

        expect(failureOf(answer, 'pinggy')?.code).toBe(ERROR_PROTECTED_PATH);
    });

    test('a file inside the config folder, and a file deeper inside it', async () => {
        const tunnel = writeFile(path.join(sources.configFolder, 'tunnels'), 'old.json');

        const direct = await deleted(sources.configFolder, ['device.json']);
        const deeper = await deleted(path.join(sources.configFolder, 'tunnels'), ['old.json']);

        expect(failureOf(direct, 'device.json')).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER });
        expect(failureOf(deeper, 'old.json')?.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(path.join(sources.configFolder, 'device.json'))).toBe(true);
        expect(fs.existsSync(tunnel)).toBe(true);
    });

    test('a system folder carries its own message', async () => {
        const answer = await deleted(workDir, ['system']);

        expect(failureOf(answer, 'system')).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_SYSTEM_FOLDER });
        expect(fs.existsSync(sources.systemFolders[0])).toBe(true);
    });

    posixTest('the config folder reached through a symlink above it', async () => {
        fs.symlinkSync(sources.home, path.join(workDir, 'my-home'));

        const answer = await deleted(path.join(workDir, 'my-home'), ['.config']);

        expect(failureOf(answer, '.config')?.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(sources.configFolder)).toBe(true);
    });

    posixTest('a directory that is a link into the config folder', async () => {
        fs.symlinkSync(sources.configFolder, path.join(workDir, 'cfg'));

        const answer = await deleted(path.join(workDir, 'cfg'), ['device.json']);

        expect(failureOf(answer, 'device.json')?.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(path.join(sources.configFolder, 'device.json'))).toBe(true);
    });

    posixTest('home as a symlink is protected both as the link and as the folder', async () => {
        const realHome = makeFolder('real-home');
        const linkedHome = path.join(workDir, 'linked-home');
        fs.symlinkSync(realHome, linkedHome);
        const linked = dependencies({ protectedSources: { ...sources, home: linkedHome } });

        const answer = await deleted(workDir, ['linked-home', 'real-home'], linked);

        expect(answer.failed_count).toBe(2);
        expect(fs.existsSync(realHome)).toBe(true);
    });

    test('a protected folder inside a tree, as a bind mount of home, ends that name', async () => {
        const folder = makeFolder('bind');
        const tree = makeFolder('bind', 'tree');
        const backup = makeFolder('bind', 'tree', 'backup');
        const homeStats = await machineFileSystemRemover.lstat(sources.home);
        const bindMounted = dependencies({
            remover: remover({
                lstat: (target) => target === backup ? Promise.resolve(homeStats) : machineFileSystemRemover.lstat(target),
            }),
        });

        const answer = await deleted(folder, ['tree'], bindMounted);

        expect(failureOf(answer, 'tree')?.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(backup)).toBe(true);
        expect(fs.existsSync(tree)).toBe(true);
    });
});

describe('the protected paths', () => {
    test('a path and every folder above it, ending at the root', () => {
        expect(selfAndAncestors('/home/alice/.config/pinggy', path.posix))
            .toEqual(['/home/alice/.config/pinggy', '/home/alice/.config', '/home/alice', '/home', '/']);
        expect(selfAndAncestors('C:\\Users\\Alice', path.win32)).toEqual(['C:\\Users\\Alice', 'C:\\Users', 'C:\\']);
    });

    test('the system folders of each OS', () => {
        expect(systemFoldersFor('linux', {})).toEqual(['/bin', '/boot', '/etc', '/lib', '/lib64', '/sbin', '/usr', '/var']);
        expect(systemFoldersFor('darwin', {}))
            .toEqual(['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/private']);
        expect(systemFoldersFor('win32', {}))
            .toEqual(['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']);
        expect(systemFoldersFor('win32', { SystemRoot: 'D:\\Windows' })[0]).toBe('D:\\Windows');
    });
});

describe('mounted disks', () => {
    test('a selected mount point is refused, and nothing on it is touched', async () => {
        const folder = makeFolder('mounts');
        const usb = makeFolder('mounts', 'usb');
        const photo = writeFile(usb, 'photo.jpg');
        const mounted = dependencies({
            remover: remover({
                lstat: async (target) => {
                    const stats = await machineFileSystemRemover.lstat(target);
                    return target === usb ? onDevice(stats, MOUNTED_DEVICE) : stats;
                },
            }),
        });

        const answer = await deleted(folder, ['usb'], mounted);

        expect(failureOf(answer, 'usb')?.code).toBe(ERROR_MOUNT_POINT);
        expect(fs.existsSync(photo)).toBe(true);
    });

    test('a mount inside a tree is skipped, the rest goes, and the next name goes on', async () => {
        const folder = makeFolder('inside');
        const work = makeFolder('inside', 'work');
        const data = makeFolder('inside', 'work', 'data');
        const onDisk = writeFile(data, 'disk.bin');
        const notes = writeFile(work, 'notes.txt');
        const other = writeFile(makeFolder('inside', 'other'), 'x.txt');
        const mounted = dependencies({
            remover: remover({
                lstat: async (target) => {
                    const stats = await machineFileSystemRemover.lstat(target);
                    return target === data ? onDevice(stats, MOUNTED_DEVICE) : stats;
                },
            }),
        });

        const answer = await deleted(folder, ['work', 'other'], mounted);

        expect(answer.completed_count).toBe(1);
        expect(failureOf(answer, 'work')?.code).toBe(ERROR_MOUNT_POINT);
        expect(fs.existsSync(onDisk)).toBe(true);
        expect(fs.existsSync(notes)).toBe(false);
        expect(fs.existsSync(path.dirname(other))).toBe(false);
    });
});

describe('failures', () => {
    test('a name already gone is path_not_found, and the next name goes on', async () => {
        const folder = makeFolder('gone');
        const kept = writeFile(folder, 'b.txt');

        const answer = await deleted(folder, ['a.txt', 'b.txt']);

        expect(answer.completed_count).toBe(1);
        expect(failureOf(answer, 'a.txt')?.code).toBe(ERROR_PATH_NOT_FOUND);
        expect(fs.existsSync(kept)).toBe(false);
    });

    test('an entry that vanishes mid-walk is ignored', async () => {
        const folder = makeFolder('vanish');
        const tree = makeFolder('vanish', 'tree');
        writeFile(tree, 'real.txt');
        const vanishing = dependencies({
            remover: remover({
                readdir: async (target) => {
                    const names = await machineFileSystemRemover.readdir(target);
                    return target === tree ? [...names, 'vanished.tmp'] : names;
                },
            }),
        });

        const answer = await deleted(folder, ['tree'], vanishing);

        expect(answer).toEqual({ completed_count: 1, failed_count: 0 });
        expect(fs.existsSync(tree)).toBe(false);
    });

    test('the first error ends the name, and the next name goes on', async () => {
        const folder = makeFolder('first-error');
        const tree = makeFolder('first-error', 'tree');
        writeFile(tree, 'a.txt');
        writeFile(tree, 'b.txt');
        const next = writeFile(folder, 'next.txt');
        const unlinked: string[] = [];
        const failing = dependencies({
            remover: remover({
                unlink: (target) => {
                    unlinked.push(target);
                    return path.dirname(target) === tree ? rejected('EACCES') : machineFileSystemRemover.unlink(target);
                },
            }),
        });

        const answer = await deleted(folder, ['tree', 'next.txt'], failing);

        expect(failureOf(answer, 'tree')?.code).toBe(ERROR_PERMISSION_DENIED);
        expect(unlinked.filter((target) => path.dirname(target) === tree)).toHaveLength(1);
        expect(fs.existsSync(next)).toBe(false);
    });

    permissionTest('a folder whose parent cannot be written: nothing inside it is removed', async () => {
        const locked = makeFolder('locked');
        const inner = makeFolder('locked', 'inner');
        const file = writeFile(inner, 'keep.txt');
        fs.chmodSync(locked, 0o555);
        try {
            const answer = await deleted(locked, ['inner']);

            expect(failureOf(answer, 'inner')?.code).toBe(ERROR_PERMISSION_DENIED);
            expect(fs.existsSync(file)).toBe(true);
        } finally {
            fs.chmodSync(locked, 0o755);
        }
    });

    test('a call that never returns is file_timeout', async () => {
        const folder = makeFolder('hung');
        writeFile(folder, 'stuck.txt');
        const hung = dependencies({
            remover: remover({ unlink: () => new Promise(() => undefined) }),
            callTimeoutMillis: 50,
        });

        const answer = await deleted(folder, ['stuck.txt'], hung);

        expect(failureOf(answer, 'stuck.txt')?.code).toBe(ERROR_FILE_TIMEOUT);
    });

    test('Windows: a read-only entry is made writable and deleted on the 2nd try', async () => {
        const calls: string[] = [];
        let unlinkTries = 0;
        const windows = dependencies({
            platform: 'win32',
            protectedSources: { home: 'C:\\Users\\alice', configFolder: 'C:\\Users\\alice\\AppData\\Roaming\\pinggy',
                systemFolders: [] },
            remover: fakeRemover({
                folders: ['C:\\data'], files: ['C:\\data\\locked.txt'],
                unlink: () => {
                    unlinkTries += 1;
                    calls.push('unlink');
                    return unlinkTries === 1 ? rejected('EPERM') : Promise.resolve();
                },
                chmod: (_target, mode) => {
                    calls.push(`chmod ${mode.toString(8)}`);
                    return Promise.resolve();
                },
            }),
        });

        const answer = await deleted('C:\\data', ['locked.txt'], windows);

        expect(answer).toEqual({ completed_count: 1, failed_count: 0 });
        expect(calls).toEqual(['unlink', 'chmod 666', 'unlink']);
    });

    test('EPERM elsewhere is permission_denied, with no retry', async () => {
        const chmod = jest.fn(() => Promise.resolve());
        const linux = dependencies({
            platform: 'linux',
            protectedSources: { home: '/home/alice', configFolder: '/home/alice/.config/pinggy', systemFolders: [] },
            remover: fakeRemover({
                folders: ['/data'], files: ['/data/a.txt'], unlink: () => rejected('EPERM'), chmod,
            }),
        });

        const answer = await deleted('/data', ['a.txt'], linux);

        expect(failureOf(answer, 'a.txt')?.code).toBe(ERROR_PERMISSION_DENIED);
        expect(chmod).not.toHaveBeenCalled();
    });
});

describe('the answer', () => {
    test('failed lists the first 20, and failed_count is the true number', async () => {
        const folder = makeFolder('many-missing');
        const names = Array.from({ length: 25 }, (_value, index) => `missing-${index}.txt`);

        const answer = await deleted(folder, names);

        expect(answer.failed_count).toBe(25);
        expect(answer.failed).toHaveLength(20);
        expect(answer.failed?.[0].name).toBe('missing-0.txt');
    });

    test('no failed field when nothing failed', async () => {
        const folder = makeFolder('clean');
        writeFile(folder, 'a.txt');

        expect(await deleted(folder, ['a.txt'])).not.toHaveProperty('failed');
    });
});

/** A whole filesystem in memory, on 1 device. `unlink` and `chmod` can be swapped. Every other path is missing. */
function fakeRemover(shape: {
    folders: string[];
    files: string[];
    unlink?: FileSystemRemover['unlink'];
    chmod?: FileSystemRemover['chmod'];
}): FileSystemRemover {
    const identities = new Map<string, bigint>();
    [...shape.folders, ...shape.files].forEach((entry, index) => identities.set(entry, BigInt(index + 10)));
    const statsOf = (target: string): Promise<fs.BigIntStats> => {
        const ino = identities.get(target);
        if (ino === undefined) {
            return rejected('ENOENT');
        }
        const folder = shape.folders.includes(target);
        return Promise.resolve({
            dev: 1n, ino, isDirectory: () => folder, isFile: () => !folder, isSymbolicLink: () => false,
        } as unknown as fs.BigIntStats);
    };
    return {
        lstat: statsOf,
        stat: statsOf,
        readdir: () => Promise.resolve([]),
        unlink: shape.unlink ?? (() => Promise.resolve()),
        rmdir: () => Promise.resolve(),
        chmod: shape.chmod ?? (() => Promise.resolve()),
    };
}

describe('the file channel handler', () => {
    const LINUX = { fs: machineFileSystem, platform: 'linux' as NodeJS.Platform };
    const LINUX_SOURCES = { home: '/home/alice', configFolder: '/home/alice/.config/pinggy', systemFolders: [] };

    function recordingHandler(dependencies: Partial<ConstructorParameters<typeof FileHandler>[0]> = {}) {
        const sent: Envelope[] = [];
        const handler = new FileHandler({ send: (frame) => sent.push(frame), ...dependencies });
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

    /** An unlink that waits for the test to let it finish. */
    function gatedUnlink() {
        const gates: Array<() => void> = [];
        const unlink = () => new Promise<void>((resolve) => gates.push(resolve));
        return { unlink, gates };
    }

    test('refuses a delete until a welcome enables it', async () => {
        const { handler, sent } = recordingHandler();

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: workDir, names: ['home'] }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });

    test('a welcome with no limit runs no delete', async () => {
        const { handler, sent } = recordingHandler({ protectedSources: sources });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: workDir, names: ['a.txt'] }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_BUSY);
    });

    test.each([
        ['no names', { directory: '/data', names: [] }],
        ['201 names', { directory: '/data', names: Array.from({ length: 201 }, (_value, index) => `n${index}`) }],
        ['names as text', { directory: '/data', names: 'a.txt' }],
        ['no directory', { names: ['a.txt'] }],
    ])('%s is invalid_payload', async (_case, payload) => {
        const { handler, sent } = recordingHandler({ protectedSources: sources });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, payload));

        expect(errorOf(sent[0]).code).toBe(ERROR_INVALID_PAYLOAD);
    });

    test('progress first, on the request id, then the answer on the same id and op', async () => {
        const folder = makeFolder('handled');
        writeFile(folder, 'a.txt');
        const { handler, sent } = recordingHandler({ protectedSources: sources });
        handler.configure(true, MAX_FRAME_BYTES, 3);
        const asked = request(CHANNEL_FILE, OP_DELETE, { directory: folder, names: ['a.txt'] });

        await handler.handle(asked);

        expect(sent.map((frame) => frame.kind)).toEqual(['event', 'res']);
        expect(sent[0]).toMatchObject({ ch: CHANNEL_FILE, op: OP_PROGRESS, id: asked.id });
        expect(sent[0].payload).toEqual({ items_done: 0, items_total: 1, files_done: 0, current_name: 'a.txt' });
        expect(sent[1]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_DELETE, id: asked.id });
        expect(sent[1].payload).toEqual({ completed_count: 1, failed_count: 0 });
    });

    test('a refusal of the whole request sends no progress', async () => {
        const { handler, sent } = recordingHandler({ protectedSources: sources });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: path.join(workDir, 'gone'), names: ['a'] }));

        expect(sent).toHaveLength(1);
        expect(errorOf(sent[0]).code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('at the limit a delete is file_busy, and each answer frees its slot', async () => {
        const { unlink, gates } = gatedUnlink();
        const { handler, sent } = recordingHandler({
            fileSystem: LINUX, protectedSources: LINUX_SOURCES,
            remover: fakeRemover({ folders: ['/data'], files: ['/data/a.txt', '/data/b.txt', '/data/c.txt'], unlink }),
        });
        handler.configure(true, MAX_FRAME_BYTES, 2);

        const first = handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['a.txt'] }));
        const second = handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['b.txt'] }));
        const third = request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['c.txt'] });
        await handler.handle(third);

        const busyAnswer = answersIn(sent).find((frame) => frame.id === third.id)!;
        expect(errorOf(busyAnswer)).toEqual({
            code: ERROR_FILE_BUSY, message: 'The device is already running 2 file operations.',
        });

        await waitUntil(() => gates.length === 2);
        gates[0]();
        await first;
        const again = request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['c.txt'] });
        const accepted = handler.handle(again);
        await waitUntil(() => gates.length === 3);
        gates[1]();
        gates[2]();
        await Promise.all([second, accepted]);

        expect(answersIn(sent).find((frame) => frame.id === again.id)!.payload)
            .toEqual({ completed_count: 1, failed_count: 0 });
    });

    test('a hung call frees its slot once it times out', async () => {
        const { handler, sent } = recordingHandler({
            fileSystem: LINUX, protectedSources: LINUX_SOURCES, deleteCallTimeoutMillis: 50,
            remover: fakeRemover({ folders: ['/data'], files: ['/data/a.txt'], unlink: () => new Promise(() => undefined) }),
        });
        handler.configure(true, MAX_FRAME_BYTES, 1);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['a.txt'] }));
        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['a.txt'] }));

        const answers = answersIn(sent);
        expect(answers).toHaveLength(2);
        expect(answers.every((frame) => (frame.payload as FileOperationAnswer).failed?.[0].error.code
            === ERROR_FILE_TIMEOUT)).toBe(true);
    });

    test('the answer fits 1 frame: failures with long names are cut, failed_count stays true', async () => {
        // 20 names of 255 control characters, about 1530 bytes each once JSON escapes them, and Node's
        // message cut to 256: about 36 KB in all.
        const names = Array.from({ length: 20 }, (_value, index) => `${index}`.padEnd(255, '\u0001'));
        const longMessage = `ENOENT: no such file or directory, lstat '/data/${'x'.repeat(300)}'`;
        const { handler, sent } = recordingHandler({
            fileSystem: LINUX, protectedSources: LINUX_SOURCES,
            remover: { ...fakeRemover({ folders: ['/data'], files: [] }), lstat: () => rejected('ENOENT', longMessage) },
        });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names }));

        const answer = answersIn(sent)[0];
        const payload = answer.payload as FileOperationAnswer;
        expect(payload.failed_count).toBe(20);
        expect(payload.failed!.length).toBeLessThan(20);
        expect(payload.failed!.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    });

    describe('the progress timer', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('1 at the start, 1 a tick on a change, a keepalive every 5 s, none after the answer', async () => {
            const { unlink, gates } = gatedUnlink();
            const { handler, sent } = recordingHandler({
                fileSystem: LINUX, protectedSources: LINUX_SOURCES,
                remover: fakeRemover({ folders: ['/data'], files: ['/data/a.txt', '/data/b.txt'], unlink }),
            });
            handler.configure(true, MAX_FRAME_BYTES, 3);
            const asked = request(CHANNEL_FILE, OP_DELETE, { directory: '/data', names: ['a.txt', 'b.txt'] });

            const handled = handler.handle(asked);
            await jest.advanceTimersByTimeAsync(0);
            expect(progressIn(sent)).toHaveLength(1);
            expect(progressIn(sent)[0].id).toBe(asked.id);

            // Nothing changes for 4 ticks: no progress.
            await jest.advanceTimersByTimeAsync(4000);
            expect(progressIn(sent)).toHaveLength(1);

            // The 5th tick sends the same counts again.
            await jest.advanceTimersByTimeAsync(1000);
            expect(progressIn(sent)).toHaveLength(2);
            expect(progressIn(sent)[1].payload).toEqual(progressIn(sent)[0].payload);

            // A count changes: the next tick sends it, and only that one.
            gates[0]();
            await jest.advanceTimersByTimeAsync(1000);
            expect(progressIn(sent)).toHaveLength(3);
            expect(progressIn(sent)[2].payload).toMatchObject({ items_done: 1, files_done: 1, current_name: 'b.txt' });

            gates[1]();
            await handled;
            const framesAtAnswer = sent.length;
            await jest.advanceTimersByTimeAsync(10_000);

            expect(sent.length).toBe(framesAtAnswer);
            expect(sent[sent.length - 1].kind).toBe('res');
        });
    });
});

/** Waits for a fake filesystem call to be made: the walk reaches it after a few awaits. */
async function waitUntil(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (!condition()) {
        throw new Error('the condition never held');
    }
}
