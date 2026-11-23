import CLIPrinter from "../utils/printer.js";
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from "./deviceIdentity.js";
import { Prompter, isInteractiveTerminal, terminalPrompter } from "./login/prompts.js";

/**
 * Whether the dashboard's file manager may reach this machine.
 *
 * device.json's `file_manager` holds the answer to {@link FILE_ACCESS_QUESTION}. `connect`, `start` and `login` ask
 * it once per device token, when a person can type. `--files on|off` answers it without the question. With no
 * terminal, nothing is asked or saved, and file access stays on. The agent reads the answer on every file request,
 * so a new answer reaches a running agent with no restart.
 */

export const FILE_ACCESS_QUESTION = "Allow file access from the Pinggy dashboard? Your account can browse, copy, "
    + "move and delete this machine's files from the browser. [Y/n] ";

export const INVALID_FILES_FLAG_MESSAGE = "--files takes on or off.";

const FILES_FLAG_ON = "on";
const FILES_FLAG_OFF = "off";

/** Enter means yes. Only an answer that starts with n means no, as in the install scripts. */
const NO_ANSWER = /^n/i;

const FILE_ACCESS_ON_MESSAGE = "File access is on. To turn it off, run: pinggy device connect --files off";
const FILE_ACCESS_OFF_MESSAGE = "File access is off. To allow it, run: pinggy device connect --files on";

/** What settling the answer touches, so a test needs no terminal and no disk. */
export interface FileAccessDependencies {
    prompter: Prompter;
    isInteractive(): boolean;
    writeIdentity(identity: DeviceIdentity): void;
    print(message: string): void;
}

export function machineFileAccessDependencies(): FileAccessDependencies {
    return {
        prompter: terminalPrompter,
        isInteractive: isInteractiveTerminal,
        writeIdentity: writeDeviceIdentity,
        print: (message) => CLIPrinter.print(message),
    };
}

/** `--files on` is true and `--files off` is false. Undefined without the flag, null for any other value. */
export function parseFilesFlag(value: string | undefined): boolean | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    switch (value.trim().toLowerCase()) {
        case FILES_FLAG_ON:
            return true;
        case FILES_FLAG_OFF:
            return false;
        default:
            return null;
    }
}

/**
 * The answer for a run on `token`: the flag, else the question, when device.json holds no answer for `token` and a
 * person can type.
 *
 * A new answer is saved at once when `stored` holds `token`, so a running agent applies it to its next file request.
 * The caller also passes it to the run. A token device.json does not hold yet gets its answer written with it at
 * `welcome`, since device.json takes a new token only once the dashboard accepts it.
 *
 * @param stored device.json, as the caller read it
 * @returns the new answer, or undefined when nothing was given or asked
 */
export async function settleFileAccess(flag: boolean | undefined, token: string, stored: DeviceIdentity | null,
                                       dependencies: FileAccessDependencies): Promise<boolean | undefined> {
    const storedForToken = stored?.token === token ? stored : null;
    let answer = flag;
    if (answer === undefined) {
        if (typeof storedForToken?.file_manager === "boolean" || !dependencies.isInteractive()) {
            return undefined;
        }
        answer = !NO_ANSWER.test((await dependencies.prompter.ask(FILE_ACCESS_QUESTION)).trim());
    }
    if (storedForToken) {
        dependencies.writeIdentity({ ...storedForToken, file_manager: answer });
    }
    dependencies.print(answer ? FILE_ACCESS_ON_MESSAGE : FILE_ACCESS_OFF_MESSAGE);
    return answer;
}

/** What the agent checks on every file request. No answer, or no readable device.json, counts as allowed. */
export function fileAccessAllowed(): boolean {
    return readDeviceIdentity()?.file_manager !== false;
}

/** The value of the `Files` line in `pinggy device status`. */
export function describeFileAccess(identity: DeviceIdentity): string {
    if (identity.file_manager === true) {
        return "on";
    }
    if (identity.file_manager === false) {
        return "off";
    }
    return "on, not asked yet";
}
