import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    assetNameFor,
    defaultDownloadDependencies,
    DownloadDependencies,
    downloadAndVerify,
    pinggyBinaryRunOptions,
    UpdateError,
    UpdateErrorCode,
} from "../update/binaryUpdater.js";
import { FakeReleaseServer, setAsset, startFakeReleaseServer } from "./helpers/fakeReleaseServer.js";

const OVERRIDE = "PINGGY_UPDATE_RELEASES_URL";
const TAG = "v0.6.5";
const ASSET = "pinggy-linux-x64";
const BODY = Buffer.from("the new binary");

let server: FakeReleaseServer;
let directory: string;
let tempPath: string;

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function dependencies(overrides: Partial<DownloadDependencies> = {}): DownloadDependencies {
    return {
        ...defaultDownloadDependencies,
        runBinary: async () => "Pinggy CLI version: 0.6.5\n",
        freeBytes: () => null,
        ...overrides,
    };
}

function offerRelease(body: Buffer = BODY, sumsBody: Buffer = body): void {
    setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from(`${sha256(sumsBody)}  ${ASSET}\n`) });
    setAsset(server, TAG, ASSET, { body });
}

const download = (overrides: Partial<DownloadDependencies> = {}): Promise<void> =>
    downloadAndVerify({ tag: TAG, assetName: ASSET, tempPath, runningVersion: "0.6.4" }, dependencies(overrides));

async function expectFailure(promise: Promise<void>, code: UpdateErrorCode): Promise<UpdateError> {
    const error = await promise.then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(UpdateError);
    expect((error as UpdateError).code).toBe(code);
    expect(fs.existsSync(tempPath)).toBe(false);
    return error as UpdateError;
}

beforeEach(async () => {
    server = await startFakeReleaseServer();
    process.env[OVERRIDE] = server.releasesUrl;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-binary-updater-"));
    tempPath = path.join(directory, "download");
});

afterEach(async () => {
    delete process.env[OVERRIDE];
    fs.rmSync(directory, { recursive: true, force: true });
    await server.close();
});

describe("downloadAndVerify", () => {
    test("a good release leaves the verified file", async () => {
        offerRelease();
        await download();
        expect(fs.readFileSync(tempPath)).toEqual(BODY);
    });

    test("no SHA256SUMS is not ready, and the binary is not requested", async () => {
        setAsset(server, TAG, ASSET, { body: BODY });
        await expectFailure(download(), UpdateErrorCode.NotReady);
        expect(server.requests.some((line) => line.includes(ASSET))).toBe(false);
    });

    test("SHA256SUMS with no line for this asset is not ready", async () => {
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from(`${sha256(BODY)}  pinggy-win-x64.exe\n`) });
        await expectFailure(download(), UpdateErrorCode.NotReady);
    });

    test("a checksum mismatch fails and counts against the release", async () => {
        offerRelease(BODY, Buffer.from("another file"));
        const error = await expectFailure(download(), UpdateErrorCode.Checksum);
        expect(error.countsAsBadRelease).toBe(true);
    });

    test("a missing Content-Length fails", async () => {
        offerRelease();
        setAsset(server, TAG, ASSET, { body: BODY, omitContentLength: true });
        await expectFailure(download(), UpdateErrorCode.Incomplete);
    });

    test("a connection cut before the last byte fails and does not count against the release", async () => {
        offerRelease();
        setAsset(server, TAG, ASSET, { body: BODY, contentLength: BODY.length + 100 });
        const error = await expectFailure(download(), UpdateErrorCode.Incomplete);
        expect(error.countsAsBadRelease).toBe(false);
    });

    test("a --version that names another version fails", async () => {
        offerRelease();
        const error = await expectFailure(download({ runBinary: async () => "Pinggy CLI version: 0.6.4\n" }), UpdateErrorCode.BadBinary);
        expect(error.countsAsBadRelease).toBe(true);
    });

    test("a binary that exits non-zero fails", async () => {
        offerRelease();
        await expectFailure(download({ runBinary: async () => { throw new Error("exit 1"); } }), UpdateErrorCode.BadBinary);
    });

    test("too little free space fails before any byte is written", async () => {
        offerRelease();
        const error = await expectFailure(download({ freeBytes: () => 1024 }), UpdateErrorCode.NoDiskSpace);
        expect(error.countsAsBadRelease).toBe(false);
    });

    test("a Windows asset needs twice the room of a macOS or Linux one", async () => {
        const windowsAsset = "pinggy-win-x64.exe";
        const size = 40 * 1024 * 1024;
        const body = Buffer.alloc(size, 1);
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from(`${sha256(body)}  ${windowsAsset}\n${sha256(body)}  ${ASSET}\n`) });
        setAsset(server, TAG, windowsAsset, { body });
        setAsset(server, TAG, ASSET, { body });
        const roomForOneCopy = size + 60 * 1024 * 1024;
        await expect(download({ freeBytes: () => roomForOneCopy })).resolves.toBeUndefined();
        await expectFailure(
            downloadAndVerify(
                { tag: TAG, assetName: windowsAsset, tempPath, runningVersion: "0.6.4" },
                dependencies({ freeBytes: () => roomForOneCopy }),
            ),
            UpdateErrorCode.NoDiskSpace,
        );
    });

    test("a redirect to plain http is refused", async () => {
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.alloc(0), redirectTo: "http://example.invalid/SHA256SUMS" });
        await expectFailure(download(), UpdateErrorCode.Network);
    });

    test("a redirect on loopback is followed", async () => {
        offerRelease();
        setAsset(server, "mirror", ASSET, { body: BODY });
        setAsset(server, TAG, ASSET, { body: Buffer.alloc(0), redirectTo: `${server.releasesUrl}/download/mirror/${ASSET}` });
        await download();
        expect(fs.readFileSync(tempPath)).toEqual(BODY);
    });

    test("a server that stops sending fails on the idle timeout", async () => {
        offerRelease();
        server.hang = true;
        await expectFailure(download({ idleTimeoutMillis: 100 }), UpdateErrorCode.Network);
    });

});

describe("running a pinggy file", () => {
    test("hides the console window and turns off PKG_EXECPATH", () => {
        const options = pinggyBinaryRunOptions();
        expect(options.windowsHide).toBe(true);
        expect(options.env?.PKG_EXECPATH).toBe("");
    });

    test("does not pass on the device token", () => {
        process.env.DEVICE_AGENT_TOKEN = "secret";
        try {
            expect(pinggyBinaryRunOptions().env?.DEVICE_AGENT_TOKEN).toBeUndefined();
        } finally {
            delete process.env.DEVICE_AGENT_TOKEN;
        }
    });
});

describe("assetNameFor", () => {
    test.each([
        ["linux", "x64", "pinggy-linux-x64"],
        ["linux", "arm64", "pinggy-linux-arm64"],
        ["darwin", "x64", "pinggy-macos-x64"],
        ["darwin", "arm64", "pinggy-macos-arm64"],
        ["win32", "x64", "pinggy-win-x64.exe"],
        ["win32", "arm64", "pinggy-win-arm64.exe"],
    ] as const)("%s %s", (platform, architecture, expected) => {
        expect(assetNameFor(platform, architecture)).toBe(expected);
    });

    test("an unknown platform throws", () => {
        expect(() => assetNameFor("freebsd", "x64")).toThrow();
    });
});
