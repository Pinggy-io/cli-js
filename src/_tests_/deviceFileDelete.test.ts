import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH,
    ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH,
    FileDeleteResult, FileError, FileProgress, OP_DELETE, OP_LIST, OP_PROGRESS,
} from '../devices/files/file_schema.js';
import { MESSAGE_DRIVE_STOPPED } from '../devices/files/fileCallGate.js';
import { DeleteDependencies, prepareDelete, runDelete } from '../devices/files/fileDelete.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import {
    MESSAGE_ACCOUNTS_FOLDER, MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, MESSAGE_PINGGY_PROGRAM,
    MESSAGE_SYSTEM_FOLDER, ProtectedSources, accountsFolderFor, agentFilesFor, selfAndAncestors, systemFoldersFor,
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

/** As the handler runs it: the checks, then the walk with `progress` set up for the 1 item. */
async function deleteAt(target: string, using: DeleteDependencies = dependencies(),
                        progress: FileProgress = newProgress()): Promise<FileDeleteResult> {
    const prepared = await prepareDelete({ path: target }, using);
    if ('error' in prepared) {
        return prepared;
    }
    progress.items_total = 1;
    progress.current_name = prepared.name;
    return runDelete(prepared, progress, using);
}

async function deleted(target: string, using?: DeleteDependencies, progress?: FileProgress): Promise<void> {
    const result = await deleteAt(target, using, progress);
    expect(result).toEqual({});
}

async function refused(target: string, using?: DeleteDependencies): Promise<FileError['error']> {
    const result = await deleteAt(target, using);
    if (!('error' in result)) {
        throw new Error(`Expected an error, got ${JSON.stringify(result)}`);
    }
    return result.error;
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
    sources = {
        home, configFolder, systemFolders: [makeFolder('system')], accountsFolder: makeFolder('accounts'),
        agentFiles: [],
    };
});

afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('deleting', () => {
    test('1 file', async () => {
        const folder = makeFolder('one');
        const file = writeFile(folder, 'notes.txt');
        const progress = newProgress();

        await deleted(file, dependencies(), progress);

        expect(fs.existsSync(file)).toBe(false);
        expect(progress).toMatchObject({ items_done: 1, files_done: 1, current_name: 'notes.txt' });
    });

    test('a tree, with every file and folder in it counted', async () => {
        const tree = makeFolder('tree-parent', 'tree');
        writeFile(tree, 'a.txt');
        writeFile(makeFolder('tree-parent', 'tree', 'sub'), 'b.txt');
        writeFile(makeFolder('tree-parent', 'tree', 'sub', 'deeper'), 'c.txt');
        const progress = newProgress();

        await deleted(tree, dependencies(), progress);

        expect(fs.existsSync(tree)).toBe(false);
        // 3 files and 3 folders.
        expect(progress.files_done).toBe(6);
    });

    test('an empty folder goes with 1 rmdir', async () => {
        const empty = makeFolder('empty-parent', 'empty');
        const progress = newProgress();

        await deleted(empty, dependencies(), progress);

        expect(fs.existsSync(empty)).toBe(false);
        expect(progress.files_done).toBe(1);
    });

    test('only the item goes: what is beside it stays', async () => {
        const folder = makeFolder('beside');
        const gone = writeFile(folder, 'a.txt');
        writeFile(folder, 'kept.txt');

        await deleted(gone);

        expect(fs.readdirSync(folder)).toEqual(['kept.txt']);
    });

    posixTest('a symlink: the link goes, the file and the folder it points at stay', async () => {
        const folder = makeFolder('links');
        const target = writeFile(makeFolder('target'), 'kept.txt');
        fs.symlinkSync(target, path.join(folder, 'to-file'));
        fs.symlinkSync(path.dirname(target), path.join(folder, 'to-folder'));

        await deleted(path.join(folder, 'to-file'));
        await deleted(path.join(folder, 'to-folder'));

        expect(fs.readdirSync(folder)).toEqual([]);
        expect(fs.existsSync(target)).toBe(true);
    });

    posixTest('a symlink inside a tree is removed, not followed', async () => {
        const tree = makeFolder('tree-with-link', 'tree');
        const target = writeFile(makeFolder('outside'), 'kept.txt');
        fs.symlinkSync(path.dirname(target), path.join(tree, 'outside-link'));

        await deleted(tree);

        expect(fs.existsSync(tree)).toBe(false);
        expect(fs.existsSync(target)).toBe(true);
    });
});

describe('the request', () => {
    test('a 255-byte name is allowed', async () => {
        const name = 'a'.repeat(255);
        const file = writeFile(makeFolder('long-name'), name);

        await deleted(file);

        expect(fs.existsSync(file)).toBe(false);
    });

    test('the path is resolved: a trailing separator and .. fold away', async () => {
        const folder = makeFolder('resolved');
        const tree = makeFolder('resolved', 'tree');
        const file = writeFile(folder, 'a.txt');

        await deleted(`${tree}${path.sep}`);
        await deleted([folder, 'other', '..', 'a.txt'].join(path.sep));

        expect(fs.existsSync(tree)).toBe(false);
        expect(fs.existsSync(file)).toBe(false);
    });

    posixTest('\\ is part of the name on Linux and macOS', async () => {
        const file = writeFile(makeFolder('backslash'), 'a\\b');

        await deleted(file);

        expect(fs.existsSync(file)).toBe(false);
    });

    test.each([
        ['a relative path', 'relative/a.txt'],
        ['a NUL byte', '/data/a\0b'],
        ['a path over 4096 bytes', `/${'d'.repeat(4096)}`],
    ])('%s is invalid_path', async (_case, target) => {
        expect((await refused(target)).code).toBe(ERROR_INVALID_PATH);
    });

    test('an item already gone is path_not_found', async () => {
        const error = await refused(path.join(makeFolder('gone'), 'a.txt'));

        expect(error.code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a missing parent folder is path_not_found', async () => {
        expect((await refused(path.join(workDir, 'gone', 'a.txt'))).code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a path under a file is path_not_found, and the file stays', async () => {
        const file = writeFile(makeFolder('not-folder'), 'plain.txt');

        expect((await refused(path.join(file, 'x'))).code).toBe(ERROR_PATH_NOT_FOUND);
        expect(fs.existsSync(file)).toBe(true);
    });

    test('a root is protected_path', async () => {
        const error = await refused(path.parse(workDir).root);

        expect(error.code).toBe(ERROR_PROTECTED_PATH);
    });
});

describe('protected folders', () => {
    test('the home folder itself', async () => {
        const error = await refused(sources.home);

        expect(error).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER });
        expect(fs.existsSync(sources.home)).toBe(true);
    });

    test('a folder above the config folder, while a file beside it goes', async () => {
        const home = sources.home;
        const tmp = writeFile(home, 'tmp.txt');

        const error = await refused(path.join(home, '.config'));
        await deleted(tmp);

        expect(error.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(tmp)).toBe(false);
        expect(fs.existsSync(path.join(sources.configFolder, 'device.json'))).toBe(true);
    });

    test('the config folder', async () => {
        expect((await refused(sources.configFolder)).code).toBe(ERROR_PROTECTED_PATH);
    });

    test('a file inside the config folder, and a file deeper inside it', async () => {
        const tunnel = writeFile(path.join(sources.configFolder, 'tunnels'), 'old.json');

        const direct = await refused(path.join(sources.configFolder, 'device.json'));
        const deeper = await refused(tunnel);

        expect(direct).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER });
        expect(deeper.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(path.join(sources.configFolder, 'device.json'))).toBe(true);
        expect(fs.existsSync(tunnel)).toBe(true);
    });

    test('a system folder carries its own message', async () => {
        const error = await refused(sources.systemFolders[0]);

        expect(error).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_SYSTEM_FOLDER });
        expect(fs.existsSync(sources.systemFolders[0])).toBe(true);
    });

    posixTest('the config folder reached through a symlink above it', async () => {
        fs.symlinkSync(sources.home, path.join(workDir, 'my-home'));

        const error = await refused(path.join(workDir, 'my-home', '.config'));

        expect(error.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(sources.configFolder)).toBe(true);
    });

    posixTest('a path through a link into the config folder', async () => {
        fs.symlinkSync(sources.configFolder, path.join(workDir, 'cfg'));

        const error = await refused(path.join(workDir, 'cfg', 'device.json'));

        expect(error.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(path.join(sources.configFolder, 'device.json'))).toBe(true);
    });

    posixTest('home as a symlink is protected both as the link and as the folder', async () => {
        const realHome = makeFolder('real-home');
        const linkedHome = path.join(workDir, 'linked-home');
        fs.symlinkSync(realHome, linkedHome);
        const linked = dependencies({ protectedSources: { ...sources, home: linkedHome } });

        const asLink = await refused(linkedHome, linked);
        const asFolder = await refused(realHome, linked);

        expect([asLink.code, asFolder.code]).toEqual([ERROR_PROTECTED_PATH, ERROR_PROTECTED_PATH]);
        expect(fs.existsSync(realHome)).toBe(true);
    });

    test('a protected folder inside a tree, as a bind mount of home, ends the delete', async () => {
        const tree = makeFolder('bind', 'tree');
        const backup = makeFolder('bind', 'tree', 'backup');
        const homeStats = await machineFileSystemRemover.lstat(sources.home);
        const bindMounted = dependencies({
            remover: remover({
                lstat: (target) => target === backup ? Promise.resolve(homeStats) : machineFileSystemRemover.lstat(target),
            }),
        });

        const error = await refused(tree, bindMounted);

        expect(error.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(backup)).toBe(true);
        expect(fs.existsSync(tree)).toBe(true);
    });

    test('the accounts folder and each account in it, with home elsewhere as for root, while inside goes', async () => {
        const bob = makeFolder('accounts', 'bob');
        const thesis = writeFile(bob, 'thesis.docx');
        const draft = writeFile(bob, 'draft.docx');

        const folder = await refused(sources.accountsFolder);
        const account = await refused(bob);
        await deleted(draft);

        expect(folder).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_ACCOUNTS_FOLDER });
        expect(account).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_ACCOUNT_FOLDER });
        expect(fs.existsSync(thesis)).toBe(true);
        expect(fs.existsSync(draft)).toBe(false);
    });

    posixTest('a path through a link to the accounts folder', async () => {
        makeFolder('accounts', 'bob');
        fs.symlinkSync(sources.accountsFolder, path.join(workDir, 'people'));

        const error = await refused(path.join(workDir, 'people', 'bob'));

        expect(error).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_ACCOUNT_FOLDER });
    });

    posixTest('Pinggy\'s program, by the link the service runs and by its real path', async () => {
        const program = writeFile(makeFolder('home', '.pinggy', 'versions', '1.2.0'), 'pinggy');
        const bin = makeFolder('home', '.pinggy', 'bin');
        const link = path.join(bin, 'pinggy');
        fs.symlinkSync(program, link);
        const beside = writeFile(bin, 'notes.txt');
        const running = dependencies({ protectedSources: { ...sources, agentFiles: [link] } });

        const binFolder = await refused(bin, running);
        const versions = await refused(path.join(sources.home, '.pinggy', 'versions'), running);
        const whole = await refused(path.join(sources.home, '.pinggy'), running);
        const theLink = await refused(link, running);
        await deleted(beside, running);

        expect(binFolder).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_PROGRAM });
        expect([versions.code, whole.code, theLink.code])
            .toEqual([ERROR_PROTECTED_PATH, ERROR_PROTECTED_PATH, ERROR_PROTECTED_PATH]);
        expect(fs.existsSync(program)).toBe(true);
        expect(fs.existsSync(beside)).toBe(false);
    });

    test('the autostart file, while another app\'s file beside it goes', async () => {
        const launchAgents = makeFolder('home', 'Library', 'LaunchAgents');
        const plist = writeFile(launchAgents, 'io.pinggy.agent.plist');
        const otherApp = writeFile(launchAgents, 'com.example.helper.plist');
        const withAutostart = dependencies({ protectedSources: { ...sources, agentFiles: [plist] } });

        const library = await refused(path.join(sources.home, 'Library'), withAutostart);
        const autostart = await refused(plist, withAutostart);
        await deleted(otherApp, withAutostart);

        expect(library).toEqual({ code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_PROGRAM });
        expect(autostart.code).toBe(ERROR_PROTECTED_PATH);
        expect(fs.existsSync(plist)).toBe(true);
        expect(fs.existsSync(otherApp)).toBe(false);
    });

    test('an agent file that does not exist protects nothing', async () => {
        const launchAgents = makeFolder('home', 'Library', 'LaunchAgents');
        writeFile(launchAgents, 'com.example.helper.plist');
        const noAutostart = dependencies({
            protectedSources: { ...sources, agentFiles: [path.join(launchAgents, 'io.pinggy.agent.plist')] },
        });

        await deleted(path.join(sources.home, 'Library'), noAutostart);

        expect(fs.existsSync(launchAgents)).toBe(false);
    });

    test('a protected folder read that times out fails the delete, and nothing goes', async () => {
        const file = writeFile(makeFolder('kept'), 'a.txt');
        const unreadable = dependencies({
            remover: remover({ realpath: () => new Promise(() => undefined) }),
            protectedSources: { ...sources, agentFiles: [file] },
            callTimeoutMillis: 50,
        });

        const error = await refused(file, unreadable);

        expect(error.code).toBe(ERROR_FILE_TIMEOUT);
        expect(fs.existsSync(file)).toBe(true);
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

    test('the accounts folder of each OS', () => {
        expect(accountsFolderFor('linux', {})).toBe('/home');
        expect(accountsFolderFor('darwin', {})).toBe('/Users');
        expect(accountsFolderFor('win32', {})).toBe('C:\\Users');
        expect(accountsFolderFor('win32', { PUBLIC: 'D:\\Users\\Public' })).toBe('D:\\Users');
    });

    test('Pinggy\'s files: the installed binary, the running program, its script, the autostart file', () => {
        expect(agentFilesFor('linux', '/home/alice', {}, '/usr/bin/node', '/usr/lib/node_modules/pinggy/dist/index.js'))
            .toEqual(['/home/alice/.pinggy/bin/pinggy', '/usr/bin/node', '/usr/lib/node_modules/pinggy/dist/index.js',
                '/home/alice/.config/systemd/user/pinggy.service']);
        expect(agentFilesFor('darwin', '/Users/alice', {}, '/Users/alice/.pinggy/bin/pinggy', undefined))
            .toEqual(['/Users/alice/.pinggy/bin/pinggy', '/Users/alice/Library/LaunchAgents/io.pinggy.agent.plist']);
        const localAppData = 'C:\\Users\\alice\\AppData\\Local';
        expect(agentFilesFor('win32', 'C:\\Users\\alice', { LOCALAPPDATA: localAppData },
            `${localAppData}\\Pinggy\\bin\\pinggy.exe`, undefined))
            .toEqual([`${localAppData}\\Pinggy\\bin\\pinggy.exe`]);
    });
});

describe('mounted disks', () => {
    test('a mount point asked for is refused, and nothing on it is touched', async () => {
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

        const error = await refused(usb, mounted);

        expect(error).toEqual({
            code: ERROR_MOUNT_POINT, message: 'This folder is a mounted disk. Open it to delete what is inside.',
        });
        expect(fs.existsSync(photo)).toBe(true);
    });

    test('a mount inside a tree is skipped, and the rest of the tree goes', async () => {
        const work = makeFolder('inside', 'work');
        const data = makeFolder('inside', 'work', 'data');
        const onDisk = writeFile(data, 'disk.bin');
        const notes = writeFile(work, 'notes.txt');
        const mounted = dependencies({
            remover: remover({
                lstat: async (target) => {
                    const stats = await machineFileSystemRemover.lstat(target);
                    return target === data ? onDevice(stats, MOUNTED_DEVICE) : stats;
                },
            }),
        });

        const error = await refused(work, mounted);

        expect(error).toEqual({
            code: ERROR_MOUNT_POINT, message: 'Another disk is mounted inside. Pinggy left it in place.',
        });
        expect(fs.existsSync(onDisk)).toBe(true);
        expect(fs.existsSync(notes)).toBe(false);
    });
});

describe('failures', () => {
    test('an entry that vanishes mid-walk is ignored', async () => {
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

        await deleted(tree, vanishing);

        expect(fs.existsSync(tree)).toBe(false);
    });

    test('the first error ends the delete, and what it removed stays removed', async () => {
        const folder = makeFolder('first-error');
        const tree = makeFolder('first-error', 'tree');
        writeFile(tree, 'a.txt');
        writeFile(tree, 'b.txt');
        const removedFirst = writeFile(makeFolder('first-error', 'tree', 'early'), 'c.txt');
        const unlinked: string[] = [];
        const failing = dependencies({
            remover: remover({
                readdir: async (target) => {
                    const names = await machineFileSystemRemover.readdir(target);
                    return target === tree ? ['early', ...names.filter((name) => name !== 'early')] : names;
                },
                unlink: (target) => {
                    unlinked.push(target);
                    return path.dirname(target) === tree ? rejected('EACCES') : machineFileSystemRemover.unlink(target);
                },
            }),
        });

        const error = await refused(tree, failing);

        expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        expect(unlinked.filter((target) => path.dirname(target) === tree)).toHaveLength(1);
        expect(fs.existsSync(removedFirst)).toBe(false);
        expect(fs.readdirSync(folder)).toEqual(['tree']);
    });

    permissionTest('a folder whose parent cannot be written: nothing inside it is removed', async () => {
        const locked = makeFolder('locked');
        const inner = makeFolder('locked', 'inner');
        const file = writeFile(inner, 'keep.txt');
        fs.chmodSync(locked, 0o555);
        try {
            const error = await refused(inner);

            expect(error.code).toBe(ERROR_PERMISSION_DENIED);
            expect(fs.existsSync(file)).toBe(true);
        } finally {
            fs.chmodSync(locked, 0o755);
        }
    });

    test('a call that never returns is file_timeout', async () => {
        const stuck = writeFile(makeFolder('hung'), 'stuck.txt');
        const hung = dependencies({
            remover: remover({ unlink: () => new Promise(() => undefined) }),
            callTimeoutMillis: 50,
        });

        const error = await refused(stuck, hung);

        expect(error.code).toBe(ERROR_FILE_TIMEOUT);
    });

    test('Windows: a read-only entry is made writable and deleted on the 2nd try', async () => {
        const calls: string[] = [];
        let unlinkTries = 0;
        const windows = dependencies({
            platform: 'win32',
            protectedSources: { home: 'C:\\Users\\alice', configFolder: 'C:\\Users\\alice\\AppData\\Roaming\\pinggy',
                systemFolders: [], accountsFolder: 'C:\\Users', agentFiles: [] },
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

        await deleted('C:\\data\\locked.txt', windows);

        expect(calls).toEqual(['unlink', 'chmod 666', 'unlink']);
    });

    test('EPERM elsewhere is permission_denied, with no retry', async () => {
        const chmod = jest.fn(() => Promise.resolve());
        const linux = dependencies({
            platform: 'linux',
            protectedSources: {
                home: '/home/alice', configFolder: '/home/alice/.config/pinggy', systemFolders: [],
                accountsFolder: '/home', agentFiles: [],
            },
            remover: fakeRemover({
                folders: ['/data'], files: ['/data/a.txt'], unlink: () => rejected('EPERM'), chmod,
            }),
        });

        const error = await refused('/data/a.txt', linux);

        expect(error.code).toBe(ERROR_PERMISSION_DENIED);
        expect(chmod).not.toHaveBeenCalled();
    });
});

/**
 * A whole filesystem in memory, on 1 device. `readdir` lists what `folders` and `files` put in a folder. `unlink`,
 * `rmdir` and `chmod` can be swapped. Every other path is missing.
 */
function fakeRemover(shape: {
    folders: string[];
    files: string[];
    unlink?: FileSystemRemover['unlink'];
    rmdir?: FileSystemRemover['rmdir'];
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
        readdir: (folder) => Promise.resolve([...shape.folders, ...shape.files]
            .filter((entry) => entry !== folder && path.posix.dirname(entry) === folder)
            .map((entry) => path.posix.basename(entry))),
        unlink: shape.unlink ?? (() => Promise.resolve()),
        rmdir: shape.rmdir ?? (() => Promise.resolve()),
        chmod: shape.chmod ?? (() => Promise.resolve()),
        realpath: (target) => identities.has(target) ? Promise.resolve(target) : rejected('ENOENT'),
    };
}

describe('the file channel handler', () => {
    const LINUX = { fs: machineFileSystem, platform: 'linux' as NodeJS.Platform };
    const LINUX_SOURCES = {
        home: '/home/alice', configFolder: '/home/alice/.config/pinggy', systemFolders: [], accountsFolder: '/home',
        agentFiles: [],
    };

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

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: sources.home }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_MANAGER_DISABLED);
    });

    test('a welcome with no limit runs no delete', async () => {
        const { handler, sent } = recordingHandler({ protectedSources: sources });
        handler.configure(true, MAX_FRAME_BYTES);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: path.join(workDir, 'a.txt') }));

        expect(errorOf(sent[0]).code).toBe(ERROR_FILE_BUSY);
    });

    test.each([
        ['no path', {}],
        ['a path that is not text', { path: ['/data/a.txt'] }],
        ['the old directory and names', { directory: '/data', names: ['a.txt'] }],
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
        const asked = request(CHANNEL_FILE, OP_DELETE, { path: path.join(folder, 'a.txt') });

        await handler.handle(asked);

        expect(sent.map((frame) => frame.kind)).toEqual(['event', 'res']);
        expect(sent[0]).toMatchObject({ ch: CHANNEL_FILE, op: OP_PROGRESS, id: asked.id });
        expect(sent[0].payload).toEqual({ items_done: 0, items_total: 1, files_done: 0, current_name: 'a.txt' });
        expect(sent[1]).toMatchObject({ kind: 'res', ch: CHANNEL_FILE, op: OP_DELETE, id: asked.id });
        expect(sent[1].payload).toEqual({});
    });

    test('a refusal by the checks sends no progress', async () => {
        const { handler, sent } = recordingHandler({ protectedSources: sources });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: path.join(workDir, 'gone', 'a') }));

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

        const first = handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: '/data/a.txt' }));
        const second = handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: '/data/b.txt' }));
        const third = request(CHANNEL_FILE, OP_DELETE, { path: '/data/c.txt' });
        await handler.handle(third);

        const busyAnswer = answersIn(sent).find((frame) => frame.id === third.id)!;
        expect(errorOf(busyAnswer)).toEqual({
            code: ERROR_FILE_BUSY, message: 'The device is already running 2 file operations.',
        });

        await waitUntil(() => gates.length === 2);
        gates[0]();
        await first;
        const again = request(CHANNEL_FILE, OP_DELETE, { path: '/data/c.txt' });
        const accepted = handler.handle(again);
        await waitUntil(() => gates.length === 3);
        gates[1]();
        gates[2]();
        await Promise.all([second, accepted]);

        expect(answersIn(sent).find((frame) => frame.id === again.id)!.payload).toEqual({});
    });

    test('a hung call frees its slot once it times out', async () => {
        const { handler, sent } = recordingHandler({
            fileSystem: LINUX, protectedSources: LINUX_SOURCES, deleteCallTimeoutMillis: 50,
            remover: fakeRemover({ folders: ['/data'], files: ['/data/a.txt'], unlink: () => new Promise(() => undefined) }),
        });
        handler.configure(true, MAX_FRAME_BYTES, 1);

        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: '/data/a.txt' }));
        await handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: '/data/a.txt' }));

        const answers = answersIn(sent);
        expect(answers).toHaveLength(2);
        expect(answers.map((frame) => errorOf(frame).code)).toEqual([ERROR_FILE_TIMEOUT, ERROR_FILE_TIMEOUT]);
    });

    test('a dead drive: 2 calls hang, then the next deletes fail at once, and so does a list', async () => {
        const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
        const { handler, sent } = recordingHandler({
            fileSystem: LINUX, protectedSources: LINUX_SOURCES, deleteCallTimeoutMillis: 50,
            remover: fakeRemover({
                folders: ['/data'], files: names.map((name) => `/data/${name}`),
                unlink: () => new Promise(() => undefined),
            }),
        });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        for (const name of names) {
            await handler.handle(request(CHANNEL_FILE, OP_DELETE, { path: `/data/${name}` }));
        }
        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: workDir }));

        const answers = answersIn(sent);
        const deleteFailures = answers.slice(0, names.length).map(errorOf);
        expect(deleteFailures.map((failure) => failure.code)).toEqual(names.map(() => ERROR_FILE_TIMEOUT));
        expect(deleteFailures.slice(2).map((failure) => failure.message)).toEqual(names.slice(2).map(() =>
            MESSAGE_DRIVE_STOPPED));
        expect(errorOf(answers[names.length])).toEqual({ code: ERROR_FILE_TIMEOUT, message: MESSAGE_DRIVE_STOPPED });
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
            let rmdirTries = 0;
            // The 1st rmdir finds the folder full, as the walk tries it before it reads the folder.
            const rmdir = () => (++rmdirTries === 1 ? rejected('ENOTEMPTY') : Promise.resolve());
            const { handler, sent } = recordingHandler({
                fileSystem: LINUX, protectedSources: LINUX_SOURCES,
                remover: fakeRemover({
                    folders: ['/data', '/data/tree'], files: ['/data/tree/a.txt', '/data/tree/b.txt'], unlink, rmdir,
                }),
            });
            handler.configure(true, MAX_FRAME_BYTES, 3);
            const asked = request(CHANNEL_FILE, OP_DELETE, { path: '/data/tree' });

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
            expect(progressIn(sent)[2].payload).toEqual({
                items_done: 0, items_total: 1, files_done: 1, current_name: 'tree',
            });

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
