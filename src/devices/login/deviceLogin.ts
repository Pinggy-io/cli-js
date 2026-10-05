import os from "os";
import CLIPrinter from "../../utils/printer.js";
import { getVersion } from "../../utils/util.js";
import { createQrCodes } from "../../tui/blessed/qrCodeGenerator.js";
import { runDeviceAgent } from "../deviceAgent.js";
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from "../deviceIdentity.js";
import {
    DEVICE_LOGIN_CLIENT_TOKEN, DeviceLoginApi, DeviceLoginApiError, buildDashboardHttpUrl, createDeviceLoginApi,
} from "./loginApi.js";
import { LoginAnswer, LoginErrorType, LoginStatus } from "./login_schema.js";
import { Prompter, isInteractiveTerminal, terminalPrompter } from "./prompts.js";

/**
 * `pinggy devices login`: sign this machine in by email, then run the device agent.
 *
 * 1. No terminal: stop, pointing at `pinggy devices connect --token`, for machines without one.
 * 2. Already enrolled: ask before adding the machine again. No runs the agent with the stored token.
 * 3. Ask for the email, and `start`: the dashboard emails a 6-digit code and an Approve link. Print the
 *    match code the approve page shows.
 * 4. Race 2 loops under 1 AbortController: the code prompt, and `poll` every few seconds. The first
 *    `approved` wins and aborts the other. A wrong code asks again; MFA asks for the authenticator code.
 *    A typed code answered `pending` lost to the emailed link: the prompt stops, and the poll collects.
 * 5. Write device.json (0600), print the device's link and its QR code, and run the agent.
 *
 * The device token is written to device.json and never printed or logged.
 *
 * See docs/pinggy-devices/slices/12-email-sign-in.md and 13-email-link-approval.md in the pinggy_backend repo.
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

const DEFAULT_SERVER = "dashboard.pinggy.io";
const YES_ANSWER = /^y(es)?$/i;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1000;
/** From this HTTP status up, a failed poll is the dashboard or its proxy blinking, not the sign-in ending. */
const FIRST_SERVER_ERROR_STATUS = 500;

const NO_TERMINAL_MESSAGE = "pinggy devices login needs a terminal to type the email and the code. "
    + "On a machine without one, add the device in the dashboard and run: pinggy devices connect --token <TOKEN>";

export interface DeviceLoginOptions {
    /** `--manage`: the dashboard's address. */
    manage?: string;
    /** `--name`: the device's name. Without it the dashboard names the device after the hostname. */
    name?: string;
}

export interface MachineDetails {
    hostname: string;
    os: string;
    arch: string;
    agent_version: string;
}

/** Everything the command touches, so a test can run it without a dashboard, a terminal or a disk. */
export interface DeviceLoginDependencies {
    createApi(manage?: string): DeviceLoginApi;
    prompter: Prompter;
    isInteractive(): boolean;
    readIdentity(): DeviceIdentity | null;
    writeIdentity(identity: DeviceIdentity): void;
    runAgent(token: string, manage?: string): Promise<void>;
    renderQr(url: string): Promise<string>;
    machine(): MachineDetails;
    print(message: string): void;
    printError(message: string): void;
    /** Resolves after `millis`, or at once when `signal` aborts. */
    sleep(millis: number, signal: AbortSignal): Promise<void>;
}

export function machineDeviceLoginDependencies(): DeviceLoginDependencies {
    return {
        createApi: (manage) => createDeviceLoginApi(manage),
        prompter: terminalPrompter,
        isInteractive: isInteractiveTerminal,
        readIdentity: readDeviceIdentity,
        writeIdentity: writeDeviceIdentity,
        runAgent: (token, manage) => runDeviceAgent(token, manage),
        renderQr: async (url) => (await createQrCodes([url]))[0],
        machine: () => ({
            hostname: os.hostname(),
            os: os.platform(),
            arch: os.arch(),
            agent_version: getVersion(),
        }),
        print: (message) => CLIPrinter.print(message),
        printError: (message) => CLIPrinter.error(message),
        sleep: sleepUnlessAborted,
    };
}

/** @returns the process exit code */
export async function runDeviceLogin(options: DeviceLoginOptions,
                                     dependencies: DeviceLoginDependencies = machineDeviceLoginDependencies()):
    Promise<number> {
    if (!dependencies.isInteractive()) {
        dependencies.printError(NO_TERMINAL_MESSAGE);
        return EXIT_FAILED;
    }

    const stored = dependencies.readIdentity();
    // As `connect` resolves it: the flag, else the dashboard this machine is enrolled on.
    const manage = options.manage ?? stored?.server;
    if (stored) {
        const answer = await dependencies.prompter.ask(
            `This machine is already enrolled as ${stored.device_agent_id ?? "a device"} on ${stored.server}. `
            + "Add it again as a new device? [y/N] ");
        if (!YES_ANSWER.test(answer.trim())) {
            await dependencies.runAgent(stored.token, manage);
            return EXIT_OK;
        }
    }

    const email = (await dependencies.prompter.ask("Email: ")).trim();
    if (!email) {
        dependencies.printError("An email is required.");
        return EXIT_FAILED;
    }

    const api = dependencies.createApi(manage);
    let approved: LoginAnswer;
    let linkMinutes: number;
    try {
        const started = await api.start({
            email,
            client_token: DEVICE_LOGIN_CLIENT_TOKEN,
            ...dependencies.machine(),
            ...(options.name ? { name: options.name } : {}),
        });
        linkMinutes = Math.round(started.expires_in_seconds / SECONDS_PER_MINUTE);
        dependencies.print(`We sent a 6-digit code to ${email}. It works for ${linkMinutes} minutes.`);
        if (started.match_code) {
            dependencies.print(`Type it below, or click Approve sign-in in the email. The page must show `
                + `${started.match_code}.`);
        }
        approved = await waitForApproval(api, started.device_code, started.poll_interval_seconds, dependencies);
    } catch (err) {
        dependencies.printError(messageOf(err, manage));
        return EXIT_FAILED;
    }

    if (!approved.token || !approved.device_agent_id) {
        dependencies.printError("The dashboard approved the sign-in without a device token. Update pinggy and "
            + "try again.");
        return EXIT_FAILED;
    }

    dependencies.writeIdentity({
        device_agent_id: approved.device_agent_id,
        token: approved.token,
        server: manage || DEFAULT_SERVER,
        enrolled_at: null,
    });
    dependencies.print(`Signed in as ${email}. Added device ${approved.device_name ?? approved.device_agent_id}.`);
    await printDeviceLink(approved, linkMinutes, dependencies);

    await dependencies.runAgent(approved.token, manage);
    return EXIT_OK;
}

/**
 * The code prompt and the poll, raced. The first `approved` wins, and the other is aborted. A refusal that
 * ends the sign-in, from either loop, ends the race.
 */
async function waitForApproval(api: DeviceLoginApi, deviceCode: string, pollIntervalSeconds: number,
                               dependencies: DeviceLoginDependencies): Promise<LoginAnswer> {
    const controller = new AbortController();
    const prompt = { showing: false };
    const typed = typeTheCode(api, deviceCode, controller.signal, prompt, dependencies);
    const polled = pollUntilApproved(api, deviceCode, pollIntervalSeconds * MILLIS_PER_SECOND, controller.signal,
        dependencies);
    // The loser settles after the abort below, and nothing waits for it.
    typed.catch(() => undefined);
    polled.catch(() => undefined);

    try {
        return await Promise.race([typed, polled]);
    } finally {
        controller.abort();
        if (prompt.showing) {
            // The poll ended the race while a question waited: finish that line before printing more.
            dependencies.print("");
        }
    }
}

async function typeTheCode(api: DeviceLoginApi, deviceCode: string, signal: AbortSignal,
                           prompt: { showing: boolean }, dependencies: DeviceLoginDependencies):
    Promise<LoginAnswer> {
    const ask = async (question: string): Promise<string> => {
        prompt.showing = true;
        try {
            return (await dependencies.prompter.ask(question, signal)).trim();
        } finally {
            prompt.showing = false;
        }
    };

    let answer: LoginAnswer | null = null;
    while (answer === null) {
        const code = await ask("Code from the email: ");
        if (code) {
            answer = await askAgainOnWrongAnswer(() => api.verifyCode(deviceCode, code), dependencies);
        }
    }
    while (answer.status === LoginStatus.MfaRequired) {
        const totp = await ask("Authenticator code: ");
        if (totp) {
            answer = await askAgainOnWrongAnswer(() => api.verifyMfa(deviceCode, totp), dependencies) ?? answer;
        }
    }
    if (answer.status === LoginStatus.Pending) {
        // The emailed link approved it first. Its device reaches this CLI through the poll, which also says
        // why if the approval failed.
        dependencies.print("Approved from the email link. Waiting for the dashboard to finish.");
        return waitUntilAborted(signal);
    }
    if (answer.status !== LoginStatus.Approved) {
        throw new DeviceLoginApiError(0, "invalid_answer",
            "The dashboard answered the code with something this pinggy cannot use. Update pinggy and try again.");
    }
    return answer;
}

/**
 * The answer, or null after a wrong code or authenticator code with attempts left: its message is printed
 * and the question is asked again. Any other refusal ends the sign-in.
 */
async function askAgainOnWrongAnswer(verify: () => Promise<LoginAnswer>,
                                     dependencies: DeviceLoginDependencies): Promise<LoginAnswer | null> {
    try {
        return await verify();
    } catch (err) {
        if (err instanceof DeviceLoginApiError && err.errorType === LoginErrorType.InvalidCode) {
            dependencies.printError(err.message);
            return null;
        }
        throw err;
    }
}

async function pollUntilApproved(api: DeviceLoginApi, deviceCode: string, intervalMillis: number,
                                 signal: AbortSignal, dependencies: DeviceLoginDependencies):
    Promise<LoginAnswer> {
    while (!signal.aborted) {
        await dependencies.sleep(intervalMillis, signal);
        if (signal.aborted) {
            break;
        }
        try {
            const answer = await api.poll(deviceCode);
            if (answer.status === LoginStatus.Approved) {
                return answer;
            }
        } catch (err) {
            // A refusal ends the sign-in: expired, or too many wrong codes. A dropped connection or a proxy
            // error does not, and the next poll tries again.
            if (err instanceof DeviceLoginApiError && err.status > 0 && err.status < FIRST_SERVER_ERROR_STATUS) {
                throw err;
            }
        }
    }
    throw signal.reason ?? new Error("The poll was stopped.");
}

async function printDeviceLink(approved: LoginAnswer, linkMinutes: number,
                               dependencies: DeviceLoginDependencies): Promise<void> {
    let link: string;
    if (approved.open_url) {
        link = approved.open_url;
        dependencies.print(`Open the device in a browser. This link signs you in once, within ${linkMinutes} `
            + "minutes:");
    } else if (approved.device_url) {
        link = approved.device_url;
        dependencies.print("Open the device in a browser:");
    } else {
        return;
    }
    dependencies.print(`  ${link}`);
    try {
        dependencies.print(await dependencies.renderQr(link));
    } catch {
        // The printed link is enough.
    }
}

function messageOf(err: unknown, manage: string | undefined): string {
    if (err instanceof DeviceLoginApiError) {
        return err.message;
    }
    // fetch puts the reason, such as ENOTFOUND, in `cause`. Read structurally: this project's `lib`
    // predates Error.cause.
    const cause = (err as { cause?: unknown } | null)?.cause;
    const causeText = cause instanceof Error ? `: ${cause.message}` : "";
    const detail = err instanceof Error ? `${err.message}${causeText}` : String(err);
    return `Could not reach the dashboard at ${buildDashboardHttpUrl(manage)} (${detail}).`;
}

/** Settles only when `signal` aborts, by rejecting: the other loop of the race decides. */
function waitUntilAborted(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
        const stop = () => reject(signal.reason ?? new Error("The wait was stopped."));
        if (signal.aborted) {
            stop();
            return;
        }
        signal.addEventListener("abort", stop, { once: true });
    });
}

function sleepUnlessAborted(millis: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, millis);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
