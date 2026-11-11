import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
    getReleasesUrl,
    isNewerVersion,
    isReleaseComplete,
    parseVersion,
    resolveLatestNpmVersion,
    resolveLatestTag,
} from "../update/latestRelease.js";
import { FakeReleaseServer, setAsset, startFakeReleaseServer } from "./helpers/fakeReleaseServer.js";

const OVERRIDE = "PINGGY_UPDATE_RELEASES_URL";
const TIMEOUT = { timeoutMillis: 2000 };

let server: FakeReleaseServer;

beforeEach(async () => {
    server = await startFakeReleaseServer();
    process.env[OVERRIDE] = server.releasesUrl;
});

afterEach(async () => {
    delete process.env[OVERRIDE];
    await server.close();
});

describe("resolveLatestTag", () => {
    test("reads the tag from the redirect and does not follow it", async () => {
        server.latestTag = "v0.6.5";
        await expect(resolveLatestTag(TIMEOUT)).resolves.toBe("v0.6.5");
        expect(server.requests).toEqual(["HEAD /releases/latest"]);
    });

    test("a pre-release shaped tag fails", async () => {
        server.latestTag = "v0.6.5-rc1";
        await expect(resolveLatestTag(TIMEOUT)).rejects.toThrow();
    });

    test("a 200 with no redirect fails", async () => {
        server.latestTag = null;
        await expect(resolveLatestTag(TIMEOUT)).rejects.toThrow();
    });

    test("a server that never answers fails at the timeout", async () => {
        server.hang = true;
        await expect(resolveLatestTag({ timeoutMillis: 100 })).rejects.toThrow(/No answer/);
    });

    test("an offline machine fails", async () => {
        await server.close();
        await expect(resolveLatestTag(TIMEOUT)).rejects.toThrow();
    });
});

describe("isReleaseComplete", () => {
    test("200 is complete", async () => {
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.from("x") });
        await expect(isReleaseComplete("v0.6.5", TIMEOUT)).resolves.toBe(true);
    });

    test("302 is complete and is not followed", async () => {
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.alloc(0), redirectTo: `${server.origin}/elsewhere` });
        await expect(isReleaseComplete("v0.6.5", TIMEOUT)).resolves.toBe(true);
        expect(server.requests).toEqual(["HEAD /releases/download/v0.6.5/SHA256SUMS"]);
    });

    test("404 is not complete", async () => {
        await expect(isReleaseComplete("v0.6.5", TIMEOUT)).resolves.toBe(false);
    });

    test("500 is a failure", async () => {
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.alloc(0), status: 500 });
        await expect(isReleaseComplete("v0.6.5", TIMEOUT)).rejects.toThrow();
    });
});

describe("resolveLatestNpmVersion", () => {
    const registryUrl = (): string => `${server.origin}/releases/download/npm/latest`;

    test("reads the version", async () => {
        setAsset(server, "npm", "latest", { body: Buffer.from(JSON.stringify({ version: "0.6.5" })) });
        await expect(resolveLatestNpmVersion(TIMEOUT, registryUrl())).resolves.toBe("0.6.5");
    });

    test("a version of the wrong shape fails", async () => {
        setAsset(server, "npm", "latest", { body: Buffer.from(JSON.stringify({ version: "latest" })) });
        await expect(resolveLatestNpmVersion(TIMEOUT, registryUrl())).rejects.toThrow();
    });

    test("an answer that is not JSON fails", async () => {
        setAsset(server, "npm", "latest", { body: Buffer.from("<html>") });
        await expect(resolveLatestNpmVersion(TIMEOUT, registryUrl())).rejects.toThrow();
    });

    test("a server that never answers fails at the timeout", async () => {
        server.hang = true;
        await expect(resolveLatestNpmVersion({ timeoutMillis: 100 }, registryUrl())).rejects.toThrow(/No answer/);
    });
});

describe("the release URL override", () => {
    const DEFAULT_URL = "https://github.com/Pinggy-io/cli-js/releases";

    test("a loopback http value is used", () => {
        process.env[OVERRIDE] = "http://127.0.0.1:9/releases";
        expect(getReleasesUrl()).toBe("http://127.0.0.1:9/releases");
        process.env[OVERRIDE] = "http://localhost:9/releases/";
        expect(getReleasesUrl()).toBe("http://localhost:9/releases");
    });

    test("an https value is ignored", () => {
        process.env[OVERRIDE] = "https://evil.example/releases";
        expect(getReleasesUrl()).toBe(DEFAULT_URL);
    });

    test("another http host is ignored", () => {
        process.env[OVERRIDE] = "http://evil.example/releases";
        expect(getReleasesUrl()).toBe(DEFAULT_URL);
    });

    test("a value that is not a URL is ignored", () => {
        process.env[OVERRIDE] = "not a url";
        expect(getReleasesUrl()).toBe(DEFAULT_URL);
    });
});

describe("versions", () => {
    test("parseVersion takes x.y.z only", () => {
        expect(parseVersion("0.6.4")).toEqual([0, 6, 4]);
        expect(parseVersion("")).toBeNull();
        expect(parseVersion("0.6")).toBeNull();
        expect(parseVersion("0.6.4-rc1")).toBeNull();
    });

    test("numbers compare as numbers", () => {
        expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    });

    test("equal is not newer, and a lower candidate is not newer", () => {
        expect(isNewerVersion("0.6.5", "0.6.5")).toBe(false);
        expect(isNewerVersion("0.6.4", "0.6.5")).toBe(false);
    });

    test("a version that does not parse is never newer", () => {
        expect(isNewerVersion("0.6.5", "")).toBe(false);
        expect(isNewerVersion("0.6.5-rc1", "0.6.4")).toBe(false);
    });
});
