import { createInterface } from "readline/promises";

/** 1 question at a time on the terminal. A signal cancels the question it was given. */
export interface Prompter {
    ask(question: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Asks on stdin and stdout. Each question gets its own readline interface, closed as soon as it is answered
 * or cancelled, so a cancelled prompt does not hold stdin open and keep the process alive.
 */
export const terminalPrompter: Prompter = {
    async ask(question: string, signal?: AbortSignal): Promise<string> {
        const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        try {
            return await readline.question(question, signal ? { signal } : {});
        } finally {
            readline.close();
        }
    },
};

/** True when a person can type answers here. Not true when stdin is a pipe, as under `curl | sh`. */
export function isInteractiveTerminal(): boolean {
    return process.stdin.isTTY === true;
}
