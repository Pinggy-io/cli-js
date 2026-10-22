import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { devicesSpellingMessage } from '../cli/subcommand/handlers/deviceCommand.js';
import { handleSubcommand, isSubcommand } from '../cli/subcommand/subcommands.js';
import { validateNameStrict } from '../cli/configStore.js';
import { plain } from './helpers/fakeDashboard.js';

/**
 * The command is `pinggy device`. `pinggy devices` is refused with a hint, and must stay a subcommand: outside
 * subcommand mode `--token` is the tunnel token, so `pinggy devices connect --token pga_...` would start a tunnel
 * with the device credential. See docs/pinggy-devices/slices/18-device-command-rename.md in the pinggy_backend repo.
 */

const VERBS = ['login', 'connect', 'stop', 'status', 'remove'];
const TOKEN = 'pga_secret_from_the_command_line';

describe('subcommand words', () => {
    test('device and devices both stay out of tunnel mode', () => {
        expect(isSubcommand(['device'])).toBe(true);
        expect(isSubcommand(['devices'])).toBe(true);
    });

    test('a new tunnel config cannot be named device or devices, in any case', () => {
        expect(validateNameStrict('device')).not.toBeNull();
        expect(validateNameStrict('Device')).not.toBeNull();
        expect(validateNameStrict('devices')).not.toBeNull();
        expect(validateNameStrict('my-device')).toBeNull();
    });
});

describe('devicesSpellingMessage', () => {
    test.each(VERBS)('names the verb %s', (verb) => {
        expect(devicesSpellingMessage([verb, '-b']))
            .toBe(`"pinggy devices" is now "pinggy device". Run: pinggy device ${verb}`);
    });

    test.each([[[]], [['help']], [['--help']], [['-h']], [['bogus']]])('names --help for %j', (args) => {
        expect(devicesSpellingMessage(args)).toBe('"pinggy devices" is now "pinggy device". Run: pinggy device --help');
    });
});

describe('pinggy devices', () => {
    let printed: string[];
    let logSpy: ReturnType<typeof jest.spyOn>;
    let errorSpy: ReturnType<typeof jest.spyOn>;
    let exitSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        printed = [];
        const capture = (...args: unknown[]) => { printed.push(plain(args.map(String).join(' '))); };
        logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(capture);
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
    });

    test('exits 1 with the hint, and never prints the token', async () => {
        await expect(handleSubcommand(['devices', 'connect', '--token', TOKEN])).rejects.toThrow('exit 1');

        expect(printed.join('\n')).toContain('Run: pinggy device connect');
        expect(printed.join('\n')).not.toContain(TOKEN);
    });
});
