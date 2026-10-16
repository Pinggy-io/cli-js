import { z } from "zod";
import {
    LoginAnswer, LoginAnswerSchema, LoginErrorSchema, LoginStarted, LoginStartedSchema,
} from "./login_schema.js";

/**
 * The HTTP calls of `pinggy devices login`, to `/backend/api/v1/device-agent/login/...`.
 *
 * These 4 paths have their own filter chain on the dashboard, with no CSRF and no session, so a plain
 * POST with a JSON body is the whole protocol. Nothing here keeps a cookie.
 */

/**
 * Sent in `start`. A public constant: it filters junk requests and is not a secret. The dashboard's
 * `pinggy.device-login.client-tokens` lists the values it accepts.
 */
export const DEVICE_LOGIN_CLIENT_TOKEN = "pinggy-cli-1";

const DEFAULT_DASHBOARD = "dashboard.pinggy.io";
const LOGIN_PATH = "/backend/api/v1/device-agent/login";
const SCHEME_PATTERN = /^(wss?|https?):\/\//i;
const PLAIN_SCHEMES = new Set(["ws", "http"]);

/**
 * The sign-in's base URL for a `--manage` value, beside `buildDeviceAgentWsUrl`: `ws://` and `http://`
 * become `http://`, anything else `https://`. No `--manage` is the production dashboard.
 */
export function buildDashboardHttpUrl(manage?: string): string {
    const address = (manage || DEFAULT_DASHBOARD).trim().replace(/\/+$/, "");
    const match = SCHEME_PATTERN.exec(address);
    const host = match ? address.slice(match[0].length) : address;
    const scheme = match && PLAIN_SCHEMES.has(match[1].toLowerCase()) ? "http" : "https";
    return `${scheme}://${host}${LOGIN_PATH}`;
}

/** A refusal, or an answer this CLI cannot read. `message` is fit to print. */
export class DeviceLoginApiError extends Error {
    constructor(readonly status: number, readonly errorType: string, message: string) {
        super(message);
        this.name = "DeviceLoginApiError";
    }
}

export interface LoginStartRequest {
    email: string;
    client_token: string;
    hostname: string;
    os: string;
    arch: string;
    agent_version: string;
    name?: string;
}

export interface DeviceLoginApi {
    start(request: LoginStartRequest): Promise<LoginStarted>;
    verifyCode(deviceCode: string, code: string): Promise<LoginAnswer>;
    verifyMfa(deviceCode: string, totp: string): Promise<LoginAnswer>;
    poll(deviceCode: string): Promise<LoginAnswer>;
}

const UNREADABLE_ANSWER = "invalid_answer";

export function createDeviceLoginApi(manage?: string, fetchImpl: typeof fetch = fetch): DeviceLoginApi {
    const baseUrl = buildDashboardHttpUrl(manage);

    async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
        const response = await fetchImpl(`${baseUrl}/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
        });
        const json = await readJson(response);

        if (!response.ok) {
            const refusal = LoginErrorSchema.safeParse(json);
            if (refusal.success && refusal.data.errors.length > 0) {
                throw new DeviceLoginApiError(response.status, refusal.data.error_type, refusal.data.errors[0]);
            }
            throw new DeviceLoginApiError(response.status, `http_${response.status}`,
                `The dashboard answered HTTP ${response.status}.`);
        }

        const answer = schema.safeParse(json);
        if (!answer.success) {
            throw new DeviceLoginApiError(response.status, UNREADABLE_ANSWER,
                "The dashboard sent an answer this pinggy cannot read. Update pinggy and try again.");
        }
        return answer.data;
    }

    return {
        start: (request) => post("start", request, LoginStartedSchema),
        verifyCode: (deviceCode, code) => post("verify-code", { device_code: deviceCode, code }, LoginAnswerSchema),
        verifyMfa: (deviceCode, totp) => post("verify-mfa", { device_code: deviceCode, totp }, LoginAnswerSchema),
        poll: (deviceCode) => post("poll", { device_code: deviceCode }, LoginAnswerSchema),
    };
}

/** The body as JSON, or undefined when it is empty or not JSON, such as an nginx error page. */
async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
