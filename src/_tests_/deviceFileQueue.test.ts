import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_PATH_NOT_FOUND, FileError, FileOperationAnswer, OP_DELETE, OP_LIST, OP_MKDIR,
    OP_PROGRESS,
} from '../devices/files/file_schema.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import { FileSystemRemover, machineFileSystem } from '../devices/files/fileSystem.js';

/**
 * The line of copies, moves and deletes that wait for a slot. Every delete runs on a filesystem in memory, and each
 * file's unlink waits for the test, so the test decides when the running operation ends.
 */

const MAX_FRAME_BYTES = 32768;
const QUEUED_KEEPALIVE_MILLIS = 5000;
const LINUX = { fs: machineFileSystem, platform: 'linux' as NodeJS.Platform };
const LINUX_SOURCES = {
    home: '/home/alice', configFolder: '/home/alice/.config/pinggy', systemFolders: [], accountsFolder: '/home',
    agentFiles: [],
};

let workDir: string;

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-queue-'));
});

afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

function rejected(code: string): Promise<never> {
    return Promise.reject(Object.assign(new Error(`${code}: fake`), { code }));
}

/**
 * Folders and files in memory, on 1 device. A test may remove a folder from `folders` while a request waits. Each
 * unlink waits in `gates` until the test lets it finish.
 */
function fakeDisk(folders: string[], files: string[]) {
    const folderSet = new Set(folders);
    const fileSet = new Set(files);
    const gates: Array<(error?: Error) => void> = [];
    const identities = new Map<string, bigint>();
    [...folders, ...files].forEach((entry, index) => identities.set(entry, BigInt(index + 10)));
    const statsOf = (target: string): Promise<fs.BigIntStats> => {
        const ino = identities.get(target);
        if (ino === undefined || (!folderSet.has(target) && !fileSet.has(target))) {
            return rejected('ENOENT');
        }
        const folder = folderSet.has(target);
        return Promise.resolve({
            dev: 1n, ino, isDirectory: () => folder, isFile: () => !folder, isSymbolicLink: () => false,
        } as unknown as fs.BigIntStats);
    };
    const remover: FileSystemRemover = {
        lstat: statsOf,
        stat: statsOf,
        readdir: () => Promise.resolve([]),
        unlink: () => new Promise<void>((resolve, reject) => {
            gates.push((error) => (error ? reject(error) : resolve()));
        }),
        rmdir: () => Promise.resolve(),
        chmod: () => Promise.resolve(),
        realpath: (target) => identities.has(target) ? Promise.resolve(target) : rejected('ENOENT'),
    };
    return { remover, gates, folderSet };
}

function recordingHandler(remover: FileSystemRemover) {
    const sent: Envelope[] = [];
    const handler = new FileHandler({
        send: (frame) => sent.push(frame), fileSystem: LINUX, protectedSources: LINUX_SOURCES, remover,
    });
    return { handler, sent };
}

function deleteRequest(name: string, directory = '/data'): Envelope {
    return request(CHANNEL_FILE, OP_DELETE, { directory, names: [name] });
}

function framesFor(sent: Envelope[], asked: Envelope): Envelope[] {
    return sent.filter((frame) => frame.id === asked.id);
}

function queuedPositionsFor(sent: Envelope[], asked: Envelope): number[] {
    return framesFor(sent, asked)
        .filter((frame) => frame.kind === 'event' && frame.op === OP_PROGRESS)
        .map((frame) => (frame.payload as { queued_position?: number }).queued_position)
        .filter((position): position is number => position !== undefined);
}

function answerFor(sent: Envelope[], asked: Envelope): Envelope | undefined {
    return framesFor(sent, asked).find((frame) => frame.kind === 'res');
}

function errorOf(frame: Envelope | undefined): FileError['error'] {
    return (frame!.payload as FileError).error;
}

async function waitUntil(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (!condition()) {
        throw new Error('the condition never held');
    }
}

describe('the line', () => {
    test('a 2nd delete waits, hears its place, then runs once the 1st answers', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a.txt', '/data/b.txt']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);
        const first = deleteRequest('a.txt');
        const second = deleteRequest('b.txt');

        const firstHandled = handler.handle(first);
        await waitUntil(() => gates.length === 1);
        const secondHandled = handler.handle(second);
        await waitUntil(() => queuedPositionsFor(sent, second).length === 1);

        expect(framesFor(sent, second)).toHaveLength(1);
        expect(framesFor(sent, second)[0]).toMatchObject({ kind: 'event', ch: CHANNEL_FILE, op: OP_PROGRESS });
        expect(framesFor(sent, second)[0].payload).toEqual({ queued_position: 1 });

        gates[0]();
        await firstHandled;
        await waitUntil(() => gates.length === 2);
        gates[1]();
        await secondHandled;

        expect(sent.filter((frame) => frame.kind === 'res').map((frame) => frame.id)).toEqual([first.id, second.id]);
        expect(framesFor(sent, second).map((frame) => frame.kind)).toEqual(['event', 'event', 'res']);
        expect(framesFor(sent, second)[1].payload)
            .toEqual({ items_done: 0, items_total: 1, files_done: 0, current_name: 'b.txt' });
        expect(answerFor(sent, second)!.payload).toEqual({ completed_count: 1, failed_count: 0 });
    });

    test('each waiting request hears its new place at once when the front starts', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b', '/data/c', '/data/d']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);
        const [first, second, third, fourth] = ['a', 'b', 'c', 'd'].map((name) => deleteRequest(name));

        const handled = [handler.handle(first)];
        await waitUntil(() => gates.length === 1);
        handled.push(handler.handle(second), handler.handle(third), handler.handle(fourth));

        expect(queuedPositionsFor(sent, second)).toEqual([1]);
        expect(queuedPositionsFor(sent, third)).toEqual([2]);
        expect(queuedPositionsFor(sent, fourth)).toEqual([3]);

        gates[0]();
        await waitUntil(() => gates.length === 2);

        expect(queuedPositionsFor(sent, second)).toEqual([1]);
        expect(queuedPositionsFor(sent, third)).toEqual([2, 1]);
        expect(queuedPositionsFor(sent, fourth)).toEqual([3, 2]);

        gates[1]();
        await waitUntil(() => gates.length === 3);
        gates[2]();
        await waitUntil(() => gates.length === 4);
        gates[3]();
        await Promise.all(handled);

        expect(sent.filter((frame) => frame.kind === 'res').map((frame) => frame.id))
            .toEqual([first.id, second.id, third.id, fourth.id]);
    });

    test('a full line answers file_busy at once, naming those waiting', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b', '/data/c', '/data/d', '/data/e']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);

        const handled = [handler.handle(deleteRequest('a'))];
        await waitUntil(() => gates.length === 1);
        handled.push(...['b', 'c', 'd'].map((name) => handler.handle(deleteRequest(name))));
        const fifth = deleteRequest('e');
        await handler.handle(fifth);

        expect(framesFor(sent, fifth)).toHaveLength(1);
        expect(errorOf(answerFor(sent, fifth))).toEqual({
            code: ERROR_FILE_BUSY, message: 'The device is already running 1 file operation, and 3 more are waiting.',
        });

        for (let index = 0; index < 4; index++) {
            await waitUntil(() => gates.length === index + 1);
            gates[index]();
        }
        await Promise.all(handled);
    });

    test('a line of 1: "1 more is waiting"', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b', '/data/c']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 1);

        const handled = [handler.handle(deleteRequest('a'))];
        await waitUntil(() => gates.length === 1);
        handled.push(handler.handle(deleteRequest('b')));
        const third = deleteRequest('c');
        await handler.handle(third);

        expect(errorOf(answerFor(sent, third)).message)
            .toBe('The device is already running 1 file operation, and 1 more is waiting.');

        gates[0]();
        await waitUntil(() => gates.length === 2);
        gates[1]();
        await Promise.all(handled);
    });

    test('a welcome with no line: nothing waits, and the 2nd answers file_busy at once', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1);

        const firstHandled = handler.handle(deleteRequest('a'));
        await waitUntil(() => gates.length === 1);
        const second = deleteRequest('b');
        await handler.handle(second);

        expect(framesFor(sent, second)).toHaveLength(1);
        expect(errorOf(answerFor(sent, second))).toEqual({
            code: ERROR_FILE_BUSY, message: 'The device is already running 1 file operation.',
        });

        gates[0]();
        await firstHandled;
    });

    test('a waiting request runs its checks when it starts: a folder gone meanwhile is path_not_found', async () => {
        const { remover, gates, folderSet } = fakeDisk(['/data', '/other'], ['/data/a', '/other/b']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);

        const firstHandled = handler.handle(deleteRequest('a'));
        await waitUntil(() => gates.length === 1);
        const second = deleteRequest('b', '/other');
        const secondHandled = handler.handle(second);
        folderSet.delete('/other');
        gates[0]();
        await Promise.all([firstHandled, secondHandled]);

        expect(framesFor(sent, second).map((frame) => frame.kind)).toEqual(['event', 'res']);
        expect(errorOf(answerFor(sent, second)).code).toBe(ERROR_PATH_NOT_FOUND);
    });

    test('a delete whose name fails still frees its slot for the next', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);
        const first = deleteRequest('a');
        const second = deleteRequest('b');

        const firstHandled = handler.handle(first);
        await waitUntil(() => gates.length === 1);
        const secondHandled = handler.handle(second);
        gates[0](Object.assign(new Error('EACCES: fake'), { code: 'EACCES' }));
        await firstHandled;
        await waitUntil(() => gates.length === 2);
        gates[1]();
        await secondHandled;

        expect((answerFor(sent, first)!.payload as FileOperationAnswer).failed_count).toBe(1);
        expect(answerFor(sent, second)!.payload).toEqual({ completed_count: 1, failed_count: 0 });
    });

    test('a list and a mkdir never wait, while 1 runs and the line is full', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b', '/data/c', '/data/d']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);

        const handled = [handler.handle(deleteRequest('a'))];
        await waitUntil(() => gates.length === 1);
        handled.push(...['b', 'c', 'd'].map((name) => handler.handle(deleteRequest(name))));
        const listed = request(CHANNEL_FILE, OP_LIST, { path: workDir });
        const made = request(CHANNEL_FILE, OP_MKDIR, { directory: workDir, name: 'new' });
        await handler.handle(listed);
        await handler.handle(made);

        expect(answerFor(sent, listed)!.payload).not.toHaveProperty('error');
        expect(answerFor(sent, made)!.payload).not.toHaveProperty('error');
        expect(fs.existsSync(path.join(workDir, 'new'))).toBe(true);

        for (let index = 0; index < 4; index++) {
            await waitUntil(() => gates.length === index + 1);
            gates[index]();
        }
        await Promise.all(handled);
    });
});

describe('a welcome while requests wait', () => {
    test('a 2nd slot starts the front of the line, and the one behind it moves up', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b', '/data/c']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);
        const third = deleteRequest('c');

        const handled = [handler.handle(deleteRequest('a'))];
        await waitUntil(() => gates.length === 1);
        handled.push(handler.handle(deleteRequest('b')), handler.handle(third));
        handler.configure(true, MAX_FRAME_BYTES, 2, 3);
        await waitUntil(() => gates.length === 2);

        expect(queuedPositionsFor(sent, third)).toEqual([2, 1]);

        gates[0]();
        gates[1]();
        await waitUntil(() => gates.length === 3);
        gates[2]();
        await Promise.all(handled);
    });

    test('no slot at all refuses those waiting with file_busy', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);

        const firstHandled = handler.handle(deleteRequest('a'));
        await waitUntil(() => gates.length === 1);
        const second = deleteRequest('b');
        const secondHandled = handler.handle(second);
        handler.configure(true, MAX_FRAME_BYTES);
        await secondHandled;

        expect(errorOf(answerFor(sent, second))).toEqual({
            code: ERROR_FILE_BUSY, message: 'The dashboard allows no file operations on this device.',
        });

        gates[0]();
        await firstHandled;
    });
});

describe('the keepalive while waiting', () => {
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('every 5 s each waiting request hears its place again, and it stops once none waits', async () => {
        const { remover, gates } = fakeDisk(['/data'], ['/data/a', '/data/b', '/data/c']);
        const { handler, sent } = recordingHandler(remover);
        handler.configure(true, MAX_FRAME_BYTES, 1, 3);
        const second = deleteRequest('b');
        const third = deleteRequest('c');

        const handled = [handler.handle(deleteRequest('a'))];
        await waitUntil(() => gates.length === 1);
        handled.push(handler.handle(second), handler.handle(third));

        await jest.advanceTimersByTimeAsync(QUEUED_KEEPALIVE_MILLIS - 1);
        expect(queuedPositionsFor(sent, second)).toEqual([1]);

        await jest.advanceTimersByTimeAsync(1);
        expect(queuedPositionsFor(sent, second)).toEqual([1, 1]);
        expect(queuedPositionsFor(sent, third)).toEqual([2, 2]);

        gates[0]();
        await waitUntil(() => gates.length === 2);
        gates[1]();
        await waitUntil(() => gates.length === 3);
        const heardByThird = queuedPositionsFor(sent, third).length;
        await jest.advanceTimersByTimeAsync(3 * QUEUED_KEEPALIVE_MILLIS);

        expect(queuedPositionsFor(sent, third)).toHaveLength(heardByThird);
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        gates[2]();
        await Promise.all(handled);
        expect(jest.getTimerCount()).toBe(0);
    });
});
