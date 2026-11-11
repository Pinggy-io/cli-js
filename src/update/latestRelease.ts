/**
 * Finds the newest release and compares versions.
 *
 * The tag comes from the `/releases/latest` redirect, as in the install scripts. Reading the redirect costs no API call.
 */
import http from "node:http";
import https from "node:https";
import { logger } from "../logger.js";

const DEFAULT_RELEASES_URL = "https://github.com/Pinggy-io/cli-js/releases";
const RELEASES_URL_OVERRIDE_ENV = "PINGGY_UPDATE_RELEASES_URL";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const USER_AGENT = "pinggy-cli";

const NPM_REGISTRY_LATEST_URL = "https://registry.npmjs.org/pinggy/latest";

export const SHA256SUMS_FILE = "SHA256SUMS";

export interface RequestTimeout {
    timeoutMillis: number;
}

/**
 * The override for dev and tests. Loopback only, so a value from a .env file or a CI variable cannot point the updater
 * at another host.
 */
export function loopbackReleasesOverride(): string | null {
    const value = process.env[RELEASES_URL_OVERRIDE_ENV];
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return value.replace(/\/+$/, "");
    } catch {
        // Not a URL. Ignored like any other refused value.
    }
    logger.debug(`Ignoring ${RELEASES_URL_OVERRIDE_ENV}. It accepts a loopback http URL only`);
    return null;
}

export function getReleasesUrl(): string {
    return loopbackReleasesOverride() ?? DEFAULT_RELEASES_URL;
}

/** HTTPS only, except the loopback address of the dev and test override. */
function isAllowedRequestUrl(url: URL): boolean {
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && loopbackReleasesOverride() !== null;
}

export function requestModuleFor(url: URL): typeof http | typeof https {
    if (!isAllowedRequestUrl(url)) throw new Error(`Refused a request to ${url.protocol}//${url.host}`);
    return url.protocol === "https:" ? https : http;
}

interface HeadResult {
    status: number;
    location?: string;
}

/** The timeout covers the whole request. Redirects are not followed, because the redirect is the answer. */
function headWithoutRedirect(target: string, timeoutMillis: number): Promise<HeadResult> {
    return new Promise((resolve, reject) => {
        const url = new URL(target);
        const request = requestModuleFor(url).request(
            url,
            { method: "HEAD", headers: { "User-Agent": USER_AGENT } },
            (response) => {
                clearTimeout(timer);
                response.resume();
                resolve({ status: response.statusCode ?? 0, location: response.headers.location });
            },
        );
        const timer = setTimeout(
            () => request.destroy(new Error(`No answer within ${timeoutMillis} ms`)),
            timeoutMillis,
        );
        request.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        request.end();
    });
}

/** @returns the tag, such as v0.6.5. Rejects when the answer is not a redirect to a `vX.Y.Z` tag. */
export async function resolveLatestTag({ timeoutMillis }: RequestTimeout): Promise<string> {
    const { status, location } = await headWithoutRedirect(`${getReleasesUrl()}/latest`, timeoutMillis);
    const tag = location?.split("?")[0].split("/").filter(Boolean).pop();
    if (status < 300 || status >= 400 || !tag || !TAG_PATTERN.test(tag)) {
        throw new Error(`Unexpected answer for the latest release: status ${status}`);
    }
    return tag;
}

/**
 * `/releases/latest` moves when a release is created, before its binaries are built. `SHA256SUMS` is the last upload,
 * so without this call the CLI would announce a version whose install command returns 404.
 *
 * @returns false for a release with no `SHA256SUMS`. Rejects on any other answer.
 */
export async function isReleaseComplete(tag: string, { timeoutMillis }: RequestTimeout): Promise<boolean> {
    const { status } = await headWithoutRedirect(`${getReleasesUrl()}/download/${tag}/${SHA256SUMS_FILE}`, timeoutMillis);
    if (status >= 200 && status < 400) return true;
    if (status === 404) return false;
    throw new Error(`Unexpected answer for ${SHA256SUMS_FILE}: status ${status}`);
}

function getJson(target: string, timeoutMillis: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const url = new URL(target);
        const request = requestModuleFor(url).get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
        const timer = setTimeout(
            () => request.destroy(new Error(`No answer within ${timeoutMillis} ms`)),
            timeoutMillis,
        );
        request.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** npm publish is a separate job from the binaries, so GitHub can name a version npm does not have yet. */
export async function resolveLatestNpmVersion(
    { timeoutMillis }: RequestTimeout,
    registryUrl: string = NPM_REGISTRY_LATEST_URL,
): Promise<string> {
    const version = (await getJson(registryUrl, timeoutMillis) as { version?: unknown } | null)?.version;
    if (typeof version !== "string" || parseVersion(version) === null) {
        throw new Error("Unexpected answer from the npm registry");
    }
    return version;
}

export function versionFromTag(tag: string): string {
    return tag.replace(/^v/, "");
}

export function parseVersion(text: string): [number, number, number] | null {
    const match = VERSION_PATTERN.exec(text);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** False when either side does not parse. */
export function isNewerVersion(candidate: string, current: string): boolean {
    const candidateParts = parseVersion(candidate);
    const currentParts = parseVersion(current);
    if (!candidateParts || !currentParts) return false;
    for (let index = 0; index < candidateParts.length; index++) {
        if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
    }
    return false;
}
