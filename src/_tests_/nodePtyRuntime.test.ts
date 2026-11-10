import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { hasExecutableSpawnHelper, isInsideAsarArchive } from '../devices/terminal/nodePtyRuntime.js';

/**
 * Where node-pty may run a shell from. On macOS a spawn whose `spawn-helper` is missing or not executable
 * kills the process from inside the addon, so the agent offers a terminal only when the helper can be
 * exec'd. Inside the Pinggy app that process is the whole app. Linux and Windows have no helper.
 */

const PREBUILD_DIRECTORY = path.join('prebuilds', `${process.platform}-${process.arch}`);

describe('hasExecutableSpawnHelper', () => {
    let packageRoot: string;

    beforeEach(() => {
        packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-node-pty-'));
    });

    afterEach(() => {
        fs.rmSync(packageRoot, { recursive: true, force: true });
    });

    function writeHelper(mode: number): void {
        const directory = path.join(packageRoot, PREBUILD_DIRECTORY);
        fs.mkdirSync(directory, { recursive: true });
        const helper = path.join(directory, 'spawn-helper');
        fs.writeFileSync(helper, '');
        fs.chmodSync(helper, mode);
    }

    // Windows file modes carry no execute bit, so a helper's mode cannot be set up there.
    const withExecuteBits = process.platform === 'win32' ? test.skip : test;

    withExecuteBits('on macOS, is true for a helper with the execute bit', () => {
        writeHelper(0o755);
        expect(hasExecutableSpawnHelper(packageRoot, 'darwin')).toBe(true);
    });

    withExecuteBits('on macOS, is false for a helper without it', () => {
        writeHelper(0o644);
        expect(hasExecutableSpawnHelper(packageRoot, 'darwin')).toBe(false);
    });

    test('on macOS, is false with no helper on disk, as inside an asar archive', () => {
        expect(hasExecutableSpawnHelper(packageRoot, 'darwin')).toBe(false);
    });

    test('on Linux, is true with no helper on disk: node-pty forks the shell with forkpty()', () => {
        expect(hasExecutableSpawnHelper(packageRoot, 'linux')).toBe(true);
    });

    test('on Windows, is true with no helper on disk', () => {
        expect(hasExecutableSpawnHelper(packageRoot, 'win32')).toBe(true);
    });
});

describe('isInsideAsarArchive', () => {
    const appPath = path.join(path.sep, 'Applications', 'Pinggy.app', 'Contents', 'Resources', 'app.asar',
        'node_modules', 'node-pty');

    test('is false outside Electron, whatever the path says', () => {
        expect(process.versions.electron).toBeUndefined();
        expect(isInsideAsarArchive(appPath)).toBe(false);
    });

    test('inside Electron, is true for a path through app.asar and false for one on disk', () => {
        Object.defineProperty(process.versions, 'electron', { value: '30.0.8', configurable: true });
        try {
            expect(isInsideAsarArchive(appPath)).toBe(true);
            const runtimeCopy = path.join(os.homedir(), '.config', 'pinggy', 'runtime', 'node-pty');
            expect(isInsideAsarArchive(runtimeCopy)).toBe(false);
        } finally {
            delete (process.versions as Record<string, string | undefined>).electron;
        }
    });
});
