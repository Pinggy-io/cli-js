import { describe, test, expect } from '@jest/globals';
import {
    ShellEnvironment, allowedShells, parseEtcShells, resolveShell,
} from '../devices/terminal/shellAllowlist.js';

// The dashboard never validates shell or cwd: only the machine knows its own filesystem. So this is
// the only check between a browser and an arbitrary binary, and it runs before every spawn.

const ETC_SHELLS = `# List of acceptable shells
/bin/bash
/bin/zsh

/bin/sh
`;

function unixEnvironment(overrides: Partial<ShellEnvironment> = {}): ShellEnvironment {
    const present = new Set(['/bin/bash', '/bin/zsh', '/bin/sh']);
    return {
        platform: 'linux',
        loginShell: '/bin/zsh',
        etcShells: ETC_SHELLS,
        exists: (path) => present.has(path),
        ...overrides,
    };
}

describe('shell allowlist', () => {
    test('/etc/shells parses to absolute paths, comments and blanks dropped', () => {
        expect(parseEtcShells(ETC_SHELLS)).toEqual(['/bin/bash', '/bin/zsh', '/bin/sh']);
    });

    test('a shell on the list that exists is spawned as asked', () => {
        expect(resolveShell('/bin/bash', unixEnvironment())).toEqual({ shell: '/bin/bash' });
    });

    test('a path not on the list is refused', () => {
        expect(resolveShell('/usr/bin/python3', unixEnvironment())).toHaveProperty('error');
    });

    test('a path that only normalises to a listed shell is refused', () => {
        expect(resolveShell('/bin/../bin/bash', unixEnvironment())).toHaveProperty('error');
    });

    test('a bare name is refused: nothing is resolved against PATH', () => {
        expect(resolveShell('bash', unixEnvironment())).toHaveProperty('error');
    });

    test('a listed shell that is not installed is refused', () => {
        const environment = unixEnvironment({ exists: (path) => path === '/bin/sh' });
        expect(resolveShell('/bin/zsh', environment)).toHaveProperty('error');
    });

    test('no request picks the login shell when it is allowed', () => {
        expect(resolveShell(null, unixEnvironment())).toEqual({ shell: '/bin/zsh' });
    });

    test('a login shell that is not allowed is passed over for the first allowed one that exists', () => {
        const environment = unixEnvironment({ loginShell: '/opt/evil/shell' });
        expect(resolveShell(undefined, environment)).toEqual({ shell: '/bin/bash' });
    });

    test('an unreadable /etc/shells falls back to a fixed list', () => {
        const environment = unixEnvironment({ etcShells: null });
        expect(allowedShells(environment)).toContain('/bin/bash');
        expect(resolveShell('/bin/bash', environment)).toEqual({ shell: '/bin/bash' });
    });

    test('nothing allowed exists: refused rather than guessed', () => {
        expect(resolveShell(null, unixEnvironment({ exists: () => false }))).toHaveProperty('error');
    });

    test('windows allows powershell and cmd by name only', () => {
        const environment = unixEnvironment({ platform: 'win32', loginShell: undefined, exists: () => false });
        expect(resolveShell('cmd.exe', environment)).toEqual({ shell: 'cmd.exe' });
        expect(resolveShell('C:\\Windows\\System32\\bash.exe', environment)).toHaveProperty('error');
        expect(resolveShell(null, environment)).toEqual({ shell: 'powershell.exe' });
    });
});