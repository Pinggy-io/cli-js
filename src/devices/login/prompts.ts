import pico from "picocolors";
import { createInterface } from "readline/promises";
import { Writable } from "stream";

/** Starts every question, so the questions stand out from the lines printed around them. */
const QUESTION_MARKER = pico.cyan(pico.bold("→"));

/** 1 question at a time on the terminal. A signal cancels the question it was given. */
export interface Prompter {
    ask(question: string, signal?: AbortSignal): Promise<string>;
    /**
     * As `ask`, but the answer does not show as it is typed, as at a password prompt. For an answer that still
     * works after it is typed, which scrollback, a shared screen or a recording of the output must not show.
     */
    askHidden(question: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Asks on `input` and `output`. Each question gets its own readline interface, closed as soon as it is
 * answered or cancelled, so a cancelled prompt does not hold stdin open and keep the process alive.
 */
export function createTerminalPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
    return {
        async ask(question: string, signal?: AbortSignal): Promise<string> {
            const readline = createInterface({ input, output, terminal: true });
            try {
                return await readline.question(marked(question), signal ? { signal } : {});
            } finally {
                readline.close();
            }
        },

        async askHidden(question: string, signal?: AbortSignal): Promise<string> {
            // readline echoes every key to its output, so it gets 1 that drops them, and the question goes
            // straight to the real output.
            output.write(marked(question));
            const readline = createInterface({ input, output: discardingOutput(), terminal: true });
            try {
                const answer = await readline.question("", signal ? { signal } : {});
                // The Enter that ended the answer was dropped too.
                output.write("\n");
                return answer;
            } finally {
                readline.close();
            }
        },
    };
}

export const terminalPrompter: Prompter = createTerminalPrompter(process.stdin, process.stdout);

/** True when a person can type answers here. Not true when stdin is a pipe, as under `curl | sh`. */
export function isInteractiveTerminal(): boolean {
    return process.stdin.isTTY === true;
}

/** readline rejects a question with this when the user presses Ctrl+C at it. */
const ABORT_ERROR_NAME = "AbortError";

/**
 * Ctrl+C at a question. The login race's own abort also rejects with an AbortError, but only in the loop that lost,
 * and nothing waits for that one. So an AbortError that reaches a caller is the user's.
 */
export function isCtrlCAtPrompt(err: unknown): boolean {
    return err instanceof Error && err.name === ABORT_ERROR_NAME;
}

function marked(question: string): string {
    return `${QUESTION_MARKER} ${question}`;
}

function discardingOutput(): Writable {
    return new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
}
