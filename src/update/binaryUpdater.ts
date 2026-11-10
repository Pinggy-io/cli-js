/**
 * Downloads a release binary and proves it is the right file before anything replaces the running one.
 *
 * Nothing runs the new file until its hash matches. Any failure deletes the temp file and leaves the install alone.
 */
import crypto from "node:crypto";
import { execFile, ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getReleasesUrl, requestModuleFor, SHA256SUMS_FILE, versionFromTag } from "./latestRelease.js";
import { errorMessage } from "../utils/util.js";

export const UpdateErrorCode = {
    NotReady: "not-ready",
    Network: "network",
    NoDiskSpace: "no-disk-space",
    Incomplete: "incomplete",
    Checksum: "checksum",
    BadBinary: "bad-binary",
    RenameFailed: "rename-failed",
    PostSwapFailed: "post-swap-failed",
    RestoreFailed: "restore-failed",
    NothingToRollBack: "nothing-to-roll-back",
} as const;
export type UpdateErrorCode = typeof UpdateErrorCode[keyof typeof UpdateErrorCode];

/** The failures that follow a complete download, so they say something about the release and not about the network. */
const BAD_RELEASE_CODES: ReadonlySet<UpdateErrorCode> = new Set<UpdateErrorCode>([
    UpdateErrorCode.Incomplete,
    UpdateErrorCode.Checksum,
    UpdateErrorCode.BadBinary,
    UpdateErrorCode.PostSwapFailed,
]);

export class UpdateError extends Error {
    readonly code: UpdateErrorCode;
    readonly countsAsBadRelease: boolean;

    constructor(code: UpdateErrorCode, message: string, options: { countsAsBadRelease?: boolean } = {}) {
        super(message);
        this.name = "UpdateError";
        this.code = code;
        this.countsAsBadRelease = options.countsAsBadRelease ?? BAD_RELEASE_CODES.has(code);
    }
}

export type PinggyBinaryRunner = (binaryPath: string, args: string[]) => Promise<string>;

const BINARY_RUN_TIMEOUT_MILLIS = 30_000;
const DEVICE_TOKEN_ENV = "DEVICE_AGENT_TOKEN";
const VERSION_LINE = /^Pinggy CLI version: (\d+\.\d+\.\d+)\s*$/m;

/** No process the CLI starts may inherit the device token. */
export function environmentWithoutDeviceToken(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment[DEVICE_TOKEN_ENV];
    return environment;
}

/**
 * The detached process has no console, so a console program it starts opens a window unless `windowsHide` is set.
 *
 * pkg adds PKG_EXECPATH=<execPath> to every child. A file at the running binary's own path then reads its first
 * argument as a script path and fails. The empty value turns that off.
 */
export function pinggyBinaryRunOptions(): ExecFileOptions {
    return {
        timeout: BINARY_RUN_TIMEOUT_MILLIS,
        windowsHide: true,
        env: { ...environmentWithoutDeviceToken(), PKG_EXECPATH: "" },
    };
}

export const runPinggyBinary: PinggyBinaryRunner = (binaryPath, args) => new Promise((resolve, reject) => {
    execFile(binaryPath, args, pinggyBinaryRunOptions(), (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
    });
});

/** @returns the x.y.z the binary reports. Rejects when it does not run or prints no version line. */
export async function readBinaryVersion(binaryPath: string, runBinary: PinggyBinaryRunner): Promise<string> {
    const match = VERSION_LINE.exec(await runBinary(binaryPath, ["--version"]));
    if (!match) throw new Error(`${binaryPath} printed no version`);
    return match[1];
}

/** Rejects when the binary does not run or prints no integer. */
export async function readBinaryIpcVersion(binaryPath: string, runBinary: PinggyBinaryRunner): Promise<number> {
    const version = Number((await runBinary(binaryPath, ["--_ipc-version"])).trim());
    if (!Number.isInteger(version)) throw new UpdateError(UpdateErrorCode.BadBinary, "The new binary reported no IPC version.");
    return version;
}

const ASSET_NAMES: Record<string, string> = {
    "linux-x64": "pinggy-linux-x64",
    "linux-arm64": "pinggy-linux-arm64",
    "darwin-x64": "pinggy-macos-x64",
    "darwin-arm64": "pinggy-macos-arm64",
    "win32-x64": "pinggy-win-x64.exe",
    "win32-arm64": "pinggy-win-arm64.exe",
};

export function assetNameFor(platform: NodeJS.Platform, architecture: string): string {
    const name = ASSET_NAMES[`${platform}-${architecture}`];
    if (!name) throw new Error(`No release asset for ${platform}-${architecture}`);
    return name;
}

export interface DownloadRequest {
    tag: string;
    assetName: string;
    tempPath: string;
    runningVersion: string;
}

export interface DownloadDependencies {
    runBinary: PinggyBinaryRunner;
    freeBytes(directory: string): number | null;
    idleTimeoutMillis: number;
}

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MILLIS = 30_000;
const FREE_SPACE_MARGIN_BYTES = 50 * 1024 * 1024;
const WINDOWS_FREE_SPACE_FACTOR = 2;
const UNIX_FREE_SPACE_FACTOR = 1;
const EXECUTABLE_MODE = 0o755;
const USER_AGENT = "pinggy-cli";
const SUMS_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

function realFreeBytes(directory: string): number | null {
    try {
        const stats = fs.statfsSync(directory);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return null;
    }
}

export const defaultDownloadDependencies: DownloadDependencies = {
    runBinary: runPinggyBinary,
    freeBytes: realFreeBytes,
    idleTimeoutMillis: IDLE_TIMEOUT_MILLIS,
};

/** Every hop goes through `requestModuleFor`, so a redirect that leaves HTTPS is refused. */
function getFollowingRedirects(target: string, idleTimeoutMillis: number, hopsLeft = MAX_REDIRECTS): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const url = new URL(target);
        const request = requestModuleFor(url).get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;
            if (status < 300 || status >= 400 || !location) {
                resolve(response);
                return;
            }
            response.resume();
            if (hopsLeft === 0) {
                reject(new Error("too many redirects"));
                return;
            }
            getFollowingRedirects(new URL(location, url).href, idleTimeoutMillis, hopsLeft - 1).then(resolve, reject);
        });
        // Idle time on the socket, so it covers a stall in the middle of the body too.
        request.setTimeout(idleTimeoutMillis, () => request.destroy(new Error("no data arrived in time")));
        request.on("error", reject);
    });
}

function unchanged(running: string): string {
    return `pinggy ${running} is unchanged.`;
}

function networkError(reason: string, running: string): UpdateError {
    return new UpdateError(UpdateErrorCode.Network, `The download failed: ${reason}. ${unchanged(running)}`);
}

function notReady(tag: string): UpdateError {
    return new UpdateError(UpdateErrorCode.NotReady, `Release ${tag} is not ready. Try again later.`);
}

async function open(url: string, running: string, idleTimeoutMillis: number): Promise<http.IncomingMessage> {
    try {
        return await getFollowingRedirects(url, idleTimeoutMillis);
    } catch (error) {
        throw networkError(errorMessage(error), running);
    }
}

function readBody(response: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
    });
}

function hashForAsset(sums: string, assetName: string): string | null {
    for (const line of sums.split("\n")) {
        const match = SUMS_LINE.exec(line.trim());
        if (match && match[2] === assetName) return match[1];
    }
    return null;
}

async function readExpectedHash(request: DownloadRequest, releaseUrl: string, dependencies: DownloadDependencies): Promise<string> {
    const { tag, assetName, runningVersion } = request;
    const response = await open(`${releaseUrl}/${SHA256SUMS_FILE}`, runningVersion, dependencies.idleTimeoutMillis);
    if (response.statusCode === 404) {
        response.resume();
        throw notReady(tag);
    }
    if (response.statusCode !== 200) {
        response.resume();
        throw networkError(`status ${response.statusCode}`, runningVersion);
    }

    let sumsBytes: Buffer;
    try {
        sumsBytes = await readBody(response);
    } catch (error) {
        throw networkError(errorMessage(error), runningVersion);
    }

    const expectedHash = hashForAsset(sumsBytes.toString("utf-8"), assetName);
    if (!expectedHash) throw notReady(tag);
    return expectedHash;
}

function writeFully(fileDescriptor: number, chunk: Buffer): void {
    let written = 0;
    while (written < chunk.length) {
        written += fs.writeSync(fileDescriptor, chunk, written);
    }
}

interface ReceivedBody {
    byteCount: number;
    sha256: string;
}

function receiveBody(response: http.IncomingMessage, fileDescriptor: number): Promise<ReceivedBody> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        let byteCount = 0;
        response.on("data", (chunk: Buffer) => {
            try {
                writeFully(fileDescriptor, chunk);
            } catch (error) {
                response.destroy();
                reject(error);
                return;
            }
            hash.update(chunk);
            byteCount += chunk.length;
        });
        response.on("end", () => resolve({ byteCount, sha256: hash.digest("hex") }));
        response.on("error", reject);
        response.on("close", () => reject(new Error("the connection closed early")));
    });
}

function noDiskSpace(running: string): UpdateError {
    return new UpdateError(UpdateErrorCode.NoDiskSpace, `Not enough free disk space for the update. ${unchanged(running)}`);
}

function ensureFreeSpace(request: DownloadRequest, contentLength: number, dependencies: DownloadDependencies): void {
    const factor = request.assetName.endsWith(".exe") ? WINDOWS_FREE_SPACE_FACTOR : UNIX_FREE_SPACE_FACTOR;
    const freeBytes = dependencies.freeBytes(path.dirname(request.tempPath));
    if (freeBytes !== null && freeBytes < contentLength * factor + FREE_SPACE_MARGIN_BYTES) {
        throw noDiskSpace(request.runningVersion);
    }
}

/**
 * A connection cut before the last byte says nothing about the release, so it does not count against it.
 * A full disk is reported as one, because that is what the user can fix.
 */
function bodyFailure(error: unknown, running: string): UpdateError {
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") return noDiskSpace(running);
    return new UpdateError(
        UpdateErrorCode.Incomplete,
        `The download was incomplete. ${unchanged(running)}`,
        { countsAsBadRelease: false },
    );
}

async function receiveVerifiedFile(
    response: http.IncomingMessage,
    request: DownloadRequest,
    expectedHash: string,
    contentLength: number,
): Promise<void> {
    const { tempPath, runningVersion } = request;
    const fileDescriptor = fs.openSync(tempPath, "w", EXECUTABLE_MODE);
    try {
        const body = await receiveBody(response, fileDescriptor).catch((error: unknown) => {
            throw bodyFailure(error, runningVersion);
        });
        if (body.byteCount !== contentLength) {
            throw new UpdateError(UpdateErrorCode.Incomplete, `The download was incomplete. ${unchanged(runningVersion)}`);
        }
        if (body.sha256 !== expectedHash) {
            throw new UpdateError(UpdateErrorCode.Checksum, `The download failed its checksum. ${unchanged(runningVersion)}`);
        }
        // On disk before any rename, so a power cut cannot leave the new name on an empty or short file.
        fs.fsyncSync(fileDescriptor);
        if (process.platform !== "win32") fs.fchmodSync(fileDescriptor, EXECUTABLE_MODE);
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

async function downloadAsset(
    request: DownloadRequest,
    releaseUrl: string,
    expectedHash: string,
    dependencies: DownloadDependencies,
): Promise<void> {
    const { assetName, runningVersion } = request;
    const response = await open(`${releaseUrl}/${assetName}`, runningVersion, dependencies.idleTimeoutMillis);
    if (response.statusCode !== 200) {
        response.resume();
        throw networkError(`status ${response.statusCode}`, runningVersion);
    }
    const contentLength = Number(response.headers["content-length"]);
    if (!Number.isInteger(contentLength)) {
        response.destroy();
        throw new UpdateError(UpdateErrorCode.Incomplete, `The download was incomplete. ${unchanged(runningVersion)}`);
    }
    try {
        ensureFreeSpace(request, contentLength, dependencies);
    } catch (error) {
        response.destroy();
        throw error;
    }
    await receiveVerifiedFile(response, request, expectedHash, contentLength);
}

async function ensureBinaryRuns(request: DownloadRequest, dependencies: DownloadDependencies): Promise<void> {
    const expected = versionFromTag(request.tag);
    const reported = await readBinaryVersion(request.tempPath, dependencies.runBinary).catch(() => null);
    if (reported !== expected) {
        throw new UpdateError(
            UpdateErrorCode.BadBinary,
            `The new binary did not run correctly. ${unchanged(request.runningVersion)}`,
        );
    }
}

export function removeQuietly(filePath: string): void {
    fs.rmSync(filePath, { force: true });
}

export async function downloadAndVerify(
    request: DownloadRequest,
    dependencies: DownloadDependencies = defaultDownloadDependencies,
): Promise<void> {
    const releaseUrl = `${getReleasesUrl()}/download/${request.tag}`;
    try {
        const expectedHash = await readExpectedHash(request, releaseUrl, dependencies);
        await downloadAsset(request, releaseUrl, expectedHash, dependencies);
        await ensureBinaryRuns(request, dependencies);
    } catch (error) {
        removeQuietly(request.tempPath);
        throw error;
    }
}
