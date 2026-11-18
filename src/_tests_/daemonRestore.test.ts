import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreCrashedTunnels, trackTunnelStop } from "../daemon/lifecycle/daemonChild.js";
import { DaemonState, loadDaemonState, restorableTunnelCount } from "../daemon/lifecycle/stateStore.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { getPinggyConfigDir } from "../utils/configDir.js";

/**
 * A host restarts a daemon that crashed, so a restore can run many times, and can itself be cut short by
 * the next crash. The state file has to stay right through all of it. The tunnels are restored at the
 * same time, so that the downtime does not grow with their number.
 */

let temporaryDirectory: string;
const savedEnvironment: Record<string, string | undefined> = {};

function statePath(): string {
    return path.join(getPinggyConfigDir(), "daemon-state.json");
}

function entry(tunnelId: string, mode: "detached" | "foreground" = "detached", configId = `config-${tunnelId}`, startedAt = new Date().toISOString()) {
    return {
        tunnelId, configId, name: tunnelId, origin: "app", mode, startedAt,
        config: { forwarding: "http://localhost:3000" },
    };
}

function writeState(tunnels: ReturnType<typeof entry>[]): void {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ tunnels, lastUpdated: "" }));
}

function idsInFile(): string[] {
    return (JSON.parse(fs.readFileSync(statePath(), "utf-8")) as DaemonState).tunnels.map(t => t.tunnelId);
}

/**
 * A manager whose starts stay pending until the test finishes them, the way a real start waits for
 * the server. `release(id)` lets a start succeed, `fail(id)` makes it throw, `stop(id)` marks the
 * tunnel stopped as a stop request does.
 */
function fakeManager() {
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const stopped = new Set<string>();
    const created: string[] = [];
    const manager = {
        createTunnel: async (config: { tunnelid: string }) => {
            created.push(config.tunnelid);
            return { tunnelid: config.tunnelid };
        },
        startTunnel: (tunnelId: string) => new Promise<void>((resolve, reject) => {
            pending.set(tunnelId, { resolve, reject });
        }),
        getManagedTunnel: (_configId: string, tunnelId: string) => ({ isStopped: stopped.has(tunnelId) }),
        getTunnelUrls: async () => [],
        registerWorkerErrorListner: async () => undefined,
        registerReconnectingListener: async () => undefined,
        registerReconnectionCompletedListener: async () => undefined,
        registerReconnectionFailedListener: async () => undefined,
    };
    return {
        manager: manager as unknown as TunnelManager,
        created,
        starting: () => Array.from(pending.keys()).sort(),
        release: (tunnelId: string) => pending.get(tunnelId)!.resolve(),
        fail: (tunnelId: string) => pending.get(tunnelId)!.reject(new Error("start failed")),
        stop: (tunnelId: string) => { stopped.add(tunnelId); },
    };
}

/** Lets the restore run up to the point where every start is waiting. */
async function untilStarting(fake: ReturnType<typeof fakeManager>, count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && fake.starting().length < count; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-restore-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
});

afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("restoreCrashedTunnels", () => {
    test("all tunnels start at the same time", async () => {
        writeState([entry("a"), entry("b"), entry("c")]);
        const fake = fakeManager();

        const restore = restoreCrashedTunnels(fake.manager);
        await untilStarting(fake, 3);

        // None has finished, and all 3 are already waiting for the server.
        expect(fake.starting()).toEqual(["a", "b", "c"]);

        for (const id of ["a", "b", "c"]) fake.release(id);
        await restore;
        expect(idsInFile().sort()).toEqual(["a", "b", "c"]);
    });

    test("every tunnel stays in the state file while it starts", async () => {
        writeState([entry("a"), entry("b"), entry("c")]);
        const fake = fakeManager();

        const restore = restoreCrashedTunnels(fake.manager);
        await untilStarting(fake, 3);
        // A daemon that dies now leaves all 3 for the next one.
        expect(idsInFile().sort()).toEqual(["a", "b", "c"]);

        fake.release("a");
        await new Promise(resolve => setImmediate(resolve));
        expect(idsInFile().sort()).toEqual(["a", "b", "c"]);

        fake.release("b");
        fake.release("c");
        await restore;
    });

    test("a tunnel that fails to start is dropped, and the others are kept", async () => {
        writeState([entry("a"), entry("b"), entry("c")]);
        const fake = fakeManager();

        const restore = restoreCrashedTunnels(fake.manager);
        await untilStarting(fake, 3);
        fake.fail("b");
        fake.release("a");
        fake.release("c");
        await restore;

        expect(idsInFile().sort()).toEqual(["a", "c"]);
    });

    test("a tunnel that was stopped while it started is not put back", async () => {
        writeState([entry("a"), entry("b")]);
        const fake = fakeManager();

        const restore = restoreCrashedTunnels(fake.manager);
        await untilStarting(fake, 2);
        // What the stop route does: the manager marks it stopped, and it leaves the state file.
        fake.stop("b");
        trackTunnelStop("b");
        fake.release("a");
        fake.release("b");
        await restore;

        expect(idsInFile()).toEqual(["a"]);
    });

    test("2 entries for 1 config restore once, the newest", async () => {
        writeState([
            entry("old", "detached", "shared-config", "2026-01-01T00:00:00.000Z"),
            entry("new", "detached", "shared-config", "2026-01-02T00:00:00.000Z"),
            entry("other"),
        ]);
        const fake = fakeManager();

        const restore = restoreCrashedTunnels(fake.manager);
        await untilStarting(fake, 2);
        expect(fake.created.sort()).toEqual(["new", "other"]);

        fake.release("new");
        fake.release("other");
        await restore;
        expect(idsInFile().sort()).toEqual(["new", "other"]);
    });

    test("foreground tunnels are not restored", async () => {
        writeState([entry("a"), entry("f", "foreground")]);
        const fake = fakeManager();

        const restore = restoreCrashedTunnels(fake.manager);
        await untilStarting(fake, 1);
        fake.release("a");
        await restore;

        expect(fake.created).toEqual(["a"]);
        expect(idsInFile()).toEqual(["a"]);
    });
});

describe("restorableTunnelCount", () => {
    test("counts the detached tunnels of a daemon that crashed", () => {
        writeState([entry("a"), entry("b"), entry("f", "foreground")]);
        expect(restorableTunnelCount()).toBe(2);
    });

    test("is 0 after a clean shutdown, which deletes the file", () => {
        expect(loadDaemonState()).toBeNull();
        expect(restorableTunnelCount()).toBe(0);
    });
});
