import { describe, test, expect } from '@jest/globals';

import {
    DeviceLoginDependencies, DeviceLoginOptions, EXIT_FAILED, EXIT_OK, MachineDetails, runDeviceLogin,
} from '../devices/login/deviceLogin.js';
import {
    DEVICE_LOGIN_CLIENT_TOKEN, DeviceLoginApi, DeviceLoginApiError, LoginStartRequest, buildDashboardHttpUrl,
    createDeviceLoginApi,
} from '../devices/login/loginApi.js';
import { LoginAnswer, LoginStarted } from '../devices/login/login_schema.js';
import { Prompter } from '../devices/login/prompts.js';
import { DeviceIdentity } from '../devices/deviceIdentity.js';

/**
 * `pinggy devices login`, slices 12 and 13: the typed code, the poll racing it and collecting an approval
 * from the emailed link, and what comes before the email.
 *
 * The dashboard, the terminal, device.json and the agent are fakes. The device token is a real-looking
 * value on purpose: it must reach device.json and the agent, and appear in nothing printed.
 *
 * See docs/pinggy-devices/slices/12-email-sign-in.md and 13-email-link-approval.md in the pinggy_backend repo.
 */

const EMAIL = 'asha@example.com';
const DEVICE_CODE = 'd'.repeat(43);
const DEVICE_TOKEN = 'pga_0123456789abcdef0123456789abcdef';
const DEVICE_AGENT_ID = '0a7d0000-0000-4000-8000-000000000001';
const OPEN_URL = 'https://dashboard.pinggy.io/pinggy-devices/open#token=' + 'o'.repeat(43);
const DEVICE_URL = `https://dashboard.pinggy.io/pinggy-devices/${DEVICE_AGENT_ID}`;
const MACHINE: MachineDetails = { hostname: 'asha-mbp', os: 'darwin', arch: 'arm64', agent_version: '0.9.0' };

const MATCH_CODE = 'KQD-WMT';
const STARTED: LoginStarted = {
    device_code: DEVICE_CODE, match_code: MATCH_CODE, expires_in_seconds: 600, poll_interval_seconds: 3,
};
const PENDING: LoginAnswer = { status: 'pending' };
const MFA_REQUIRED: LoginAnswer = { status: 'mfa_required' };
const APPROVED_BY_CODE: LoginAnswer = {
    status: 'approved', token: DEVICE_TOKEN, device_agent_id: DEVICE_AGENT_ID, device_name: 'asha-mbp',
    open_url: OPEN_URL,
};
const APPROVED_ELSEWHERE: LoginAnswer = {
    status: 'approved', token: DEVICE_TOKEN, device_agent_id: DEVICE_AGENT_ID, device_name: 'asha-mbp',
    device_url: DEVICE_URL,
};

function refusal(status: number, errorType: string, message: string): DeviceLoginApiError {
    return new DeviceLoginApiError(status, errorType, message);
}

const WRONG_CODE = refusal(400, 'device_login_invalid_code', 'Wrong code. 4 attempts left.');
const WRONG_TOTP = refusal(400, 'device_login_invalid_code', 'Wrong authenticator code. 4 attempts left.');
const EXPIRED = refusal(410, 'device_login_expired', 'This sign-in has expired. Run pinggy devices login again.');
const TOO_MANY_CHECKS = refusal(429, 'device_login_rate_limited',
    'Too many code checks for this email. Try again within the hour, or add the device from the dashboard.');

type Scripted = LoginAnswer | Error;

/** A dashboard that answers from scripts, in order. An unscripted poll answers pending. */
function fakeApi(script: { startError?: Error; verifyCode?: Scripted[]; verifyMfa?: Scripted[]; poll?: Scripted[] }) {
    const calls = { start: [] as LoginStartRequest[], verifyCode: [] as string[], verifyMfa: [] as string[], poll: 0 };
    const next = (queue: Scripted[] | undefined, fallback: () => Promise<LoginAnswer>): Promise<LoginAnswer> => {
        const item = queue?.shift();
        if (item === undefined) {
            return fallback();
        }
        return item instanceof Error ? Promise.reject(item) : Promise.resolve(item);
    };
    const api: DeviceLoginApi = {
        start: (request) => {
            calls.start.push(request);
            return script.startError ? Promise.reject(script.startError) : Promise.resolve(STARTED);
        },
        verifyCode: (deviceCode, code) => {
            expect(deviceCode).toBe(DEVICE_CODE);
            calls.verifyCode.push(code);
            return next(script.verifyCode, () => Promise.reject(new Error('no scripted verify-code answer')));
        },
        verifyMfa: (deviceCode, totp) => {
            expect(deviceCode).toBe(DEVICE_CODE);
            calls.verifyMfa.push(totp);
            return next(script.verifyMfa, () => Promise.reject(new Error('no scripted verify-mfa answer')));
        },
        poll: (deviceCode) => {
            expect(deviceCode).toBe(DEVICE_CODE);
            calls.poll += 1;
            return next(script.poll, () => Promise.resolve(PENDING));
        },
    };
    return { api, calls };
}

/**
 * Answers questions from a list, in order, hidden or not. With the list spent, a question waits until its
 * signal aborts, as a real prompt waits for a person, and then rejects, as readline does.
 */
function fakePrompter(answers: string[]) {
    const asked: string[] = [];
    /** The questions asked with askHidden, also in `asked`. */
    const askedHidden: string[] = [];
    let cancelled = 0;
    const answer = (question: string, signal?: AbortSignal): Promise<string> => {
        asked.push(question);
        const next = answers.shift();
        if (next !== undefined) {
            return Promise.resolve(next);
        }
        if (!signal) {
            return Promise.reject(new Error(`no answer for "${question}" and nothing can cancel it`));
        }
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                cancelled += 1;
                reject(new Error('The operation was aborted'));
            }, { once: true });
        });
    };
    const prompter: Prompter = {
        ask: answer,
        askHidden(question: string, signal?: AbortSignal): Promise<string> {
            askedHidden.push(question);
            return answer(question, signal);
        },
    };
    return { prompter, asked, askedHidden, cancelledCount: () => cancelled };
}

/** A poll that never comes round: the typed code is the only way through. */
function sleepUntilAborted(_millis: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/** A poll at once, after the event loop has had a turn, so the loop cannot starve the prompt. */
function sleepOneTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: {
    answers: string[];
    api: DeviceLoginApi;
    stored?: DeviceIdentity;
    interactive?: boolean;
    sleep?: DeviceLoginDependencies['sleep'];
}) {
    const prompts = fakePrompter(options.answers);
    const printed: string[] = [];
    const errors: string[] = [];
    const written: DeviceIdentity[] = [];
    const agentRuns: Array<[string, string | undefined]> = [];
    const apiManages: Array<string | undefined> = [];
    const dependencies: DeviceLoginDependencies = {
        createApi: (manage) => {
            apiManages.push(manage);
            return options.api;
        },
        prompter: prompts.prompter,
        isInteractive: () => options.interactive ?? true,
        readIdentity: () => options.stored ?? null,
        writeIdentity: (identity) => {
            written.push(identity);
        },
        runAgent: async (token, manage) => {
            agentRuns.push([token, manage]);
        },
        renderQr: async (url) => `QR(${url})`,
        machine: () => MACHINE,
        print: (message) => {
            printed.push(message);
        },
        printError: (message) => {
            errors.push(message);
        },
        sleep: options.sleep ?? sleepUntilAborted,
    };
    const run = (runOptions: DeviceLoginOptions = {}) => runDeviceLogin(runOptions, dependencies);
    return { run, prompts, printed, errors, written, agentRuns, apiManages };
}

describe('the typed code', () => {
    test('signs in, writes device.json, prints the one-time link and its QR, and runs the agent', async () => {
        const { api, calls } = fakeApi({ verifyCode: [APPROVED_BY_CODE] });
        const cli = harness({ answers: [EMAIL, '123456'], api });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(calls.start).toEqual([{ email: EMAIL, client_token: DEVICE_LOGIN_CLIENT_TOKEN, ...MACHINE }]);
        expect(calls.verifyCode).toEqual(['123456']);
        expect(cli.written).toEqual([{
            device_agent_id: DEVICE_AGENT_ID, token: DEVICE_TOKEN, server: 'dashboard.pinggy.io', enrolled_at: null,
        }]);
        expect(cli.printed).toContain(`Signed in as ${EMAIL}. Added device asha-mbp.`);
        expect(cli.printed).toContain(`  ${OPEN_URL}`);
        expect(cli.printed).toContain(`QR(${OPEN_URL})`);
        expect(cli.agentRuns).toEqual([[DEVICE_TOKEN, undefined]]);
        expect(JSON.stringify([cli.printed, cli.errors])).not.toContain(DEVICE_TOKEN);
    });

    test('a wrong code prints why and asks again', async () => {
        const { api, calls } = fakeApi({ verifyCode: [WRONG_CODE, APPROVED_BY_CODE] });
        const cli = harness({ answers: [EMAIL, '000000', '123456'], api });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(calls.verifyCode).toEqual(['000000', '123456']);
        expect(cli.errors).toEqual([WRONG_CODE.message]);
        expect(cli.prompts.asked.filter((question) => question === 'Code from the email: ')).toHaveLength(2);
    });

    test('an empty answer is asked again, without a call', async () => {
        const { api, calls } = fakeApi({ verifyCode: [APPROVED_BY_CODE] });
        const cli = harness({ answers: [EMAIL, '  ', '123456'], api });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(calls.verifyCode).toEqual(['123456']);
    });

    test('with MFA on, asks for the authenticator code, and again after a wrong one', async () => {
        const { api, calls } = fakeApi({ verifyCode: [MFA_REQUIRED], verifyMfa: [WRONG_TOTP, APPROVED_BY_CODE] });
        const cli = harness({ answers: [EMAIL, '123456', '000000', '654321'], api });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(calls.verifyMfa).toEqual(['000000', '654321']);
        expect(cli.errors).toEqual([WRONG_TOTP.message]);
        expect(cli.prompts.asked.filter((question) => question === 'Authenticator code: ')).toHaveLength(2);
        // The authenticator code only: it still works after it is typed, and the open link asks for one.
        expect(cli.prompts.askedHidden).toEqual(['Authenticator code: ', 'Authenticator code: ']);
        expect(cli.agentRuns).toEqual([[DEVICE_TOKEN, undefined]]);
    });

    test('any other refusal ends the sign-in with its message, and writes nothing', async () => {
        const { api } = fakeApi({ verifyCode: [TOO_MANY_CHECKS] });
        const cli = harness({ answers: [EMAIL, '123456'], api });

        expect(await cli.run()).toBe(EXIT_FAILED);

        expect(cli.errors).toEqual([TOO_MANY_CHECKS.message]);
        expect(cli.prompts.asked.filter((question) => question === 'Code from the email: ')).toHaveLength(1);
        expect(cli.written).toEqual([]);
        expect(cli.agentRuns).toEqual([]);
    });

    test('the device is named by --name when it is given', async () => {
        const { api, calls } = fakeApi({ verifyCode: [APPROVED_BY_CODE] });
        const cli = harness({ answers: [EMAIL, '123456'], api });

        await cli.run({ name: 'build-box' });

        expect(calls.start[0].name).toBe('build-box');
    });
});

describe('the poll', () => {
    test('the sign-in ending mid-prompt stops the CLI and cancels the prompt', async () => {
        const { api } = fakeApi({ poll: [PENDING, EXPIRED] });
        const cli = harness({ answers: [EMAIL], api, sleep: sleepOneTurn });

        expect(await cli.run()).toBe(EXIT_FAILED);

        expect(cli.errors).toEqual([EXPIRED.message]);
        expect(cli.prompts.cancelledCount()).toBe(1);
        expect(cli.written).toEqual([]);
        expect(cli.agentRuns).toEqual([]);
    });

    test('an approval found by the poll wins over the prompt, and prints the plain device page', async () => {
        const { api } = fakeApi({ poll: [PENDING, APPROVED_ELSEWHERE] });
        const cli = harness({ answers: [EMAIL], api, sleep: sleepOneTurn });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(cli.prompts.cancelledCount()).toBe(1);
        expect(cli.printed).toContain(`  ${DEVICE_URL}`);
        expect(cli.printed.join('\n')).not.toContain('signs you in once');
        expect(cli.written[0].token).toBe(DEVICE_TOKEN);
        expect(cli.agentRuns).toEqual([[DEVICE_TOKEN, undefined]]);
    });

    test('a typed code that lost to the emailed link stops asking, and the poll collects the device', async () => {
        const { api, calls } = fakeApi({ verifyCode: [PENDING], poll: [APPROVED_ELSEWHERE] });
        const cli = harness({ answers: [EMAIL, '123456'], api, sleep: sleepOneTurn });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(calls.verifyCode).toEqual(['123456']);
        expect(cli.prompts.asked.filter((question) => question === 'Code from the email: ')).toHaveLength(1);
        expect(cli.printed).toContain('Approved from the email link. Waiting for the dashboard to finish.');
        expect(cli.printed).toContain(`  ${DEVICE_URL}`);
        expect(cli.printed.join('\n')).not.toContain(OPEN_URL);
        expect(cli.errors).toEqual([]);
        expect(cli.written[0].token).toBe(DEVICE_TOKEN);
    });

    test('the match code is printed, so the approve page can be checked against it', async () => {
        const { api } = fakeApi({ verifyCode: [APPROVED_BY_CODE] });
        const cli = harness({ answers: [EMAIL, '123456'], api });

        await cli.run();

        expect(cli.printed.join('\n')).toContain(MATCH_CODE);
    });

    test('a dropped connection or a proxy error does not end the sign-in', async () => {
        const { api } = fakeApi({
            poll: [new TypeError('fetch failed'), refusal(502, 'http_502', 'The dashboard answered HTTP 502.'),
                APPROVED_ELSEWHERE],
        });
        const cli = harness({ answers: [EMAIL], api, sleep: sleepOneTurn });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(cli.errors).toEqual([]);
    });
});

describe('before the email', () => {
    test('without a terminal, stops and points at connect --token', async () => {
        const { api } = fakeApi({});
        const cli = harness({ answers: [], api, interactive: false });

        expect(await cli.run()).toBe(EXIT_FAILED);

        expect(cli.errors[0]).toContain('pinggy devices connect --token');
        expect(cli.apiManages).toEqual([]);
    });

    test('an enrolled machine, answered no, runs the agent with its stored token', async () => {
        const { api } = fakeApi({});
        const stored: DeviceIdentity = {
            device_agent_id: DEVICE_AGENT_ID, token: 'pga_stored', server: 'ws://dashboard.localhost.pinggy.io',
            enrolled_at: null,
        };
        const cli = harness({ answers: [''], api, stored });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(cli.agentRuns).toEqual([['pga_stored', 'ws://dashboard.localhost.pinggy.io']]);
        expect(cli.apiManages).toEqual([]);
    });

    test('an enrolled machine, answered yes, signs in again on the dashboard it is enrolled on', async () => {
        const { api } = fakeApi({ verifyCode: [APPROVED_BY_CODE] });
        const stored: DeviceIdentity = {
            device_agent_id: DEVICE_AGENT_ID, token: 'pga_stored', server: 'ws://dashboard.localhost.pinggy.io',
            enrolled_at: null,
        };
        const cli = harness({ answers: ['y', EMAIL, '123456'], api, stored });

        expect(await cli.run()).toBe(EXIT_OK);

        expect(cli.apiManages).toEqual(['ws://dashboard.localhost.pinggy.io']);
        expect(cli.written[0].server).toBe('ws://dashboard.localhost.pinggy.io');
        expect(cli.agentRuns).toEqual([[DEVICE_TOKEN, 'ws://dashboard.localhost.pinggy.io']]);
    });

    test('a refused start stops with its message', async () => {
        const tooManySignIns = refusal(429, 'device_login_rate_limited',
            'Too many sign-ins for this email in the last hour. Try again later.');
        const { api } = fakeApi({ startError: tooManySignIns });
        const cli = harness({ answers: [EMAIL], api });

        expect(await cli.run()).toBe(EXIT_FAILED);

        expect(cli.errors).toEqual([tooManySignIns.message]);
    });

    test('an unreachable dashboard says where it tried', async () => {
        // As fetch reports it: the reason is in `cause`.
        const unreachable = Object.assign(new TypeError('fetch failed'),
            { cause: new Error('getaddrinfo ENOTFOUND dashboard') });
        const { api } = fakeApi({ startError: unreachable });
        const cli = harness({ answers: [EMAIL], api });

        expect(await cli.run()).toBe(EXIT_FAILED);

        expect(cli.errors[0]).toContain('https://dashboard.pinggy.io/backend/api/v1/device-agent/login');
        expect(cli.errors[0]).toContain('ENOTFOUND');
    });
});

describe('buildDashboardHttpUrl', () => {
    test.each([
        [undefined, 'https://dashboard.pinggy.io/backend/api/v1/device-agent/login'],
        ['dashboard.pinggy.io', 'https://dashboard.pinggy.io/backend/api/v1/device-agent/login'],
        ['wss://dashboard.pinggy.io', 'https://dashboard.pinggy.io/backend/api/v1/device-agent/login'],
        ['ws://dashboard.localhost.pinggy.io', 'http://dashboard.localhost.pinggy.io/backend/api/v1/device-agent/login'],
        ['http://localhost:8080/', 'http://localhost:8080/backend/api/v1/device-agent/login'],
        ['https://example.com', 'https://example.com/backend/api/v1/device-agent/login'],
    ])('%s becomes %s', (manage, expected) => {
        expect(buildDashboardHttpUrl(manage)).toBe(expected);
    });
});

describe('the HTTP client', () => {
    const BASE = 'http://dashboard.localhost.pinggy.io/backend/api/v1/device-agent/login';

    function fetchAnswering(status: number, body: string, contentType = 'application/json') {
        const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            requests.push({ url: String(url), init });
            return new Response(body, { status, headers: { 'Content-Type': contentType } });
        }) as typeof fetch;
        return { fetchImpl, requests };
    }

    test('posts JSON to the path and reads the answer', async () => {
        const { fetchImpl, requests } = fetchAnswering(200, JSON.stringify(STARTED));
        const api = createDeviceLoginApi('ws://dashboard.localhost.pinggy.io', fetchImpl);
        const request: LoginStartRequest = { email: EMAIL, client_token: DEVICE_LOGIN_CLIENT_TOKEN, ...MACHINE };

        expect(await api.start(request)).toEqual(STARTED);

        expect(requests[0].url).toBe(`${BASE}/start`);
        expect(requests[0].init?.method).toBe('POST');
        expect(JSON.parse(String(requests[0].init?.body))).toEqual(request);
    });

    test('a refusal becomes an error with its status, type and message', async () => {
        const { fetchImpl } = fetchAnswering(400, JSON.stringify({
            error_type: 'device_login_invalid_code', errors: ['Wrong code. 4 attempts left.'],
        }));
        const api = createDeviceLoginApi('ws://dashboard.localhost.pinggy.io', fetchImpl);

        await expect(api.verifyCode(DEVICE_CODE, '000000')).rejects.toMatchObject({
            status: 400, errorType: 'device_login_invalid_code', message: 'Wrong code. 4 attempts left.',
        });
    });

    test('an error page that is not JSON becomes http_<status>', async () => {
        const { fetchImpl } = fetchAnswering(502, '<html>Bad Gateway</html>', 'text/html');
        const api = createDeviceLoginApi(undefined, fetchImpl);

        await expect(api.poll(DEVICE_CODE)).rejects.toMatchObject({ status: 502, errorType: 'http_502' });
    });

    test('an answer this build cannot read is refused', async () => {
        const { fetchImpl } = fetchAnswering(200, JSON.stringify({ status: 'something-new' }));
        const api = createDeviceLoginApi(undefined, fetchImpl);

        await expect(api.poll(DEVICE_CODE)).rejects.toMatchObject({ errorType: 'invalid_answer' });
    });
});
