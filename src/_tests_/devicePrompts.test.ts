import { describe, test, expect } from '@jest/globals';
import { PassThrough } from 'stream';

import { createTerminalPrompter } from '../devices/login/prompts.js';

/**
 * The terminal prompter on in-memory streams: what the screen shows while an answer is typed.
 *
 * `askHidden` reads the authenticator code. The code still works after it is typed, and the open link printed
 * right after asks for one, so the scrollback must not show it. See docs/pinggy-devices/decisions.md in the
 * pinggy_backend repo.
 */

/** A terminal: keys go in through `type`, and `shown` is everything written to the screen so far. */
function fakeTerminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => {
        shown += chunk.toString();
    });
    return {
        prompter: createTerminalPrompter(input, output),
        type: (keys: string) => input.write(keys),
        shown: () => shown,
    };
}

describe('terminal prompter', () => {
    test('askHidden shows the question and a line end, never the answer', async () => {
        const terminal = fakeTerminal();

        const answer = terminal.prompter.askHidden('Authenticator code: ');
        terminal.type('654321\r');

        expect(await answer).toBe('654321');
        expect(terminal.shown()).toBe('Authenticator code: \n');
    });

    test('ask shows the answer as it is typed', async () => {
        const terminal = fakeTerminal();

        const answer = terminal.prompter.ask('Code from the email: ');
        terminal.type('123456\r');

        expect(await answer).toBe('123456');
        expect(terminal.shown()).toContain('Code from the email: ');
        expect(terminal.shown()).toContain('123456');
    });

    /** The poll won the race: the caller ends the line, so the prompt must not end it too. */
    test('askHidden stops when its signal aborts, and adds no line end', async () => {
        const terminal = fakeTerminal();
        const controller = new AbortController();

        const answer = terminal.prompter.askHidden('Authenticator code: ', controller.signal);
        terminal.type('65');
        controller.abort();

        await expect(answer).rejects.toThrow();
        expect(terminal.shown()).toBe('Authenticator code: ');
    });
});
