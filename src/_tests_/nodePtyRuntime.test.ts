import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { hasExecutableSpawnHelper, isInsideAsarArchive } from '../devices/terminal/nodePtyRuntime.js';

/**
 * Where node-pty may run a shell from. A spawn whose `spawn-helper` is missing or not executable kills the
 * process from inside the addon, so the agent offers a terminal only when the helper can be exec'd. Inside
 * the Pinggy app that process is the whole app.
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

    const unixOnly = process.platform === 'win32' ? test.skip : test;

    unixOnly('is true for a helper with the execute bit', () => {
        writeHelper(0o755);
        expect(hasExecutableSpawnHelper(packageRoot)).toBe(true);
    });

    unixOnly('is false for a helper without it', () => {
        writeHelper(0o644);
        expect(hasExecutableSpawnHelper(packageRoot)).toBe(false);
    });

    unixOnly('is false with no helper on disk, as inside an asar archive', () => {
        expect(hasExecutableSpawnHelper(packageRoot)).toBe(false);
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
