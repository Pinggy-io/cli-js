import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Envelope, request } from '../devices/envelope.js';
import { CHANNEL_FILE, ERROR_FILE_TIMEOUT, FileError, OP_LIST, OP_STAT } from '../devices/files/file_schema.js';
import { FileCallGate, FileCallsStuckError, MESSAGE_DRIVE_STOPPED } from '../devices/files/fileCallGate.js';
import { FileHandler } from '../devices/files/fileHandler.js';
import { FileCallTimeoutError, FileSystemReader, machineFileSystem } from '../devices/files/fileSystem.js';

/**
 * The gate every file manager filesystem call goes through: at most N calls at once, a call that times out while
 * waiting never runs, and once N calls are stuck past their limit every call fails at once until 1 finishes.
 */

const LONG_MILLIS = 10_000;
const SHORT_MILLIS = 20;
const MAX_FRAME_BYTES = 32768;

/** A call the test finishes by hand. */
function heldCall<T>(value: T) {
    let finish: () => void = () => undefined;
    let started = false;
    const work = () => {
        started = true;
        return new Promise<T>((resolve) => {
            finish = () => resolve(value);
        });
    };
    return { work, finish: () => finish(), started: () => started };
}

/** Lets the promise callbacks queued so far run. */
async function settle(): Promise<void> {
    for (let round = 0; round < 5; round++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

describe('the file call gate', () => {
    test('runs at most its places at once, and the next starts when 1 finishes', async () => {
        const gate = new FileCallGate(2);
        const calls = [heldCall('a'), heldCall('b'), heldCall('c')];

        const results = calls.map((call) => gate.run(call.work, LONG_MILLIS));
        expect(calls.map((call) => call.started())).toEqual([true, true, false]);

        calls[0].finish();
        await expect(results[0]).resolves.toBe('a');
        await settle();
        expect(calls[2].started()).toBe(true);

        calls[1].finish();
        calls[2].finish();
        await expect(Promise.all(results.slice(1))).resolves.toEqual(['b', 'c']);
    });

    test('a call that times out while waiting is dropped and never runs', async () => {
        const gate = new FileCallGate(1);
        const running = heldCall('a');
        const waiting = heldCall('b');

        const first = gate.run(running.work, LONG_MILLIS);
        const second = gate.run(waiting.work, SHORT_MILLIS);
        await expect(second).rejects.toBeInstanceOf(FileCallTimeoutError);
        running.finish();
        await first;
        await settle();

        expect(waiting.started()).toBe(false);
    });

    test('with every place held by an abandoned call, every call fails at once, waiting ones too', async () => {
        const gate = new FileCallGate(2);
        const hung = [heldCall('a'), heldCall('b')];
        const waiting = heldCall('c');

        const outcomes = await Promise.allSettled([
            ...hung.map((call) => gate.run(call.work, SHORT_MILLIS)),
            gate.run(waiting.work, LONG_MILLIS),
        ]);
        const later = heldCall('d');
        const refusedAtOnce = gate.run(later.work, LONG_MILLIS);

        expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
        expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(FileCallTimeoutError);
        expect((outcomes[2] as PromiseRejectedResult).reason).toBeInstanceOf(FileCallsStuckError);
        await expect(refusedAtOnce).rejects.toThrow(MESSAGE_DRIVE_STOPPED);
        expect(waiting.started()).toBe(false);
        expect(later.started()).toBe(false);
    });

    test('once an abandoned call finishes, its place frees and calls run again', async () => {
        const gate = new FileCallGate(1);
        const hung = heldCall('a');

        await expect(gate.run(hung.work, SHORT_MILLIS)).rejects.toBeInstanceOf(FileCallTimeoutError);
        await expect(gate.run(heldCall('x').work, LONG_MILLIS)).rejects.toBeInstanceOf(FileCallsStuckError);
        hung.finish();
        await settle();

        await expect(gate.run(() => Promise.resolve('b'), LONG_MILLIS)).resolves.toBe('b');
    });

    test('a call that fails, or throws before it returns a promise, frees its place', async () => {
        const gate = new FileCallGate(1);

        await expect(gate.run(() => Promise.reject(new Error('EIO')), LONG_MILLIS)).rejects.toThrow('EIO');
        await expect(gate.run(() => {
            throw new Error('bad argument');
        }, LONG_MILLIS)).rejects.toThrow('bad argument');

        await expect(gate.run(() => Promise.resolve('ok'), LONG_MILLIS)).resolves.toBe('ok');
    });

    test('needs at least 1 place', () => {
        expect(() => new FileCallGate(0)).toThrow();
    });
});

describe('the gate in the file channel', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-file-gate-'));
        for (let index = 0; index < 10; index++) {
            fs.writeFileSync(path.join(workDir, `file-${index}.txt`), 'a');
        }
    });

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    test('a list whose lstats hang holds 2 calls, and a stat after it answers at once', async () => {
        let lstatsStarted = 0;
        const hangingLstat: FileSystemReader = {
            ...machineFileSystem,
            lstat: () => {
                lstatsStarted += 1;
                return new Promise(() => undefined);
            },
        };
        const sent: Envelope[] = [];
        const handler = new FileHandler({
            send: (frame) => sent.push(frame),
            fileSystem: { fs: hangingLstat, platform: process.platform },
            readTimeoutMillis: 50,
        });
        handler.configure(true, MAX_FRAME_BYTES, 3);

        await handler.handle(request(CHANNEL_FILE, OP_LIST, { path: workDir, sort_by: 'size' }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const startedBy = Date.now();
        await handler.handle(request(CHANNEL_FILE, OP_STAT, { path: workDir }));

        expect(lstatsStarted).toBe(2);
        expect((sent[0].payload as FileError).error.code).toBe(ERROR_FILE_TIMEOUT);
        expect((sent[1].payload as FileError).error).toEqual({ code: ERROR_FILE_TIMEOUT, message: MESSAGE_DRIVE_STOPPED });
        expect(Date.now() - startedBy).toBeLessThan(50);
    });
});
