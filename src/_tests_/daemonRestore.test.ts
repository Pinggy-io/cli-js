import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreCrashedTunnels } from "../daemon/lifecycle/daemonChild.js";
import { DaemonState, loadDaemonState, restorableTunnelCount } from "../daemon/lifecycle/stateStore.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { getPinggyConfigDir } from "../utils/configDir.js";

/**
 * A host restarts a daemon that crashed, so a restore can run many times, and can itself be cut short by
 * the next crash. The state file has to stay right through all of it.
 */

let temporaryDirectory: string;
const savedEnvironment: Record<string, string | undefined> = {};

function statePath(): string {
    return path.join(getPinggyConfigDir(), "daemon-state.json");
}

function entry(tunnelId: string, mode: "detached" | "foreground" = "detached") {
    return {
        tunnelId, configId: `config-${tunnelId}`, name: tunnelId, origin: "app", mode,
        startedAt: new Date().toISOString(),
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

/** A manager whose start records what the state file holds at that moment, and fails for `failing`. */
function fakeManager(failing: string[] = []) {
    const fileDuringStart: Record<string, string[]> = {};
    const manager = {
        createTunnel: async (config: { tunnelid: string }) => ({ tunnelid: config.tunnelid }),
        startTunnel: async (tunnelId: string) => {
            fileDuringStart[tunnelId] = idsInFile();
            if (failing.includes(tunnelId)) throw new Error("start failed");
        },
        getTunnelUrls: async () => [],
        registerWorkerErrorListner: async () => undefined,
        registerReconnectingListener: async () => undefined,
        registerReconnectionCompletedListener: async () => undefined,
        registerReconnectionFailedListener: async () => undefined,
    };
    return { manager: manager as unknown as TunnelManager, fileDuringStart };
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
    test("every restored tunnel is back in the state file", async () => {
        writeState([entry("a"), entry("b"), entry("c")]);

        await restoreCrashedTunnels(fakeManager().manager);

        expect(idsInFile().sort()).toEqual(["a", "b", "c"]);
    });

    test("a tunnel is out of the state file while it starts, and the ones not tried yet stay in it", async () => {
        writeState([entry("a"), entry("b"), entry("c")]);
        const { manager, fileDuringStart } = fakeManager();

        await restoreCrashedTunnels(manager);

        // A crash during a's start leaves b and c for the next daemon, and not a.
        expect(fileDuringStart.a.sort()).toEqual(["b", "c"]);
        expect(fileDuringStart.b.sort()).toEqual(["a", "c"]);
        expect(fileDuringStart.c.sort()).toEqual(["a", "b"]);
    });

    test("a tunnel that fails to start is dropped, and the others are kept", async () => {
        writeState([entry("a"), entry("b"), entry("c")]);

        await restoreCrashedTunnels(fakeManager(["b"]).manager);

        expect(idsInFile().sort()).toEqual(["a", "c"]);
    });

    test("foreground tunnels are not restored", async () => {
        writeState([entry("a"), entry("f", "foreground")]);
        const { manager, fileDuringStart } = fakeManager();

        await restoreCrashedTunnels(manager);

        expect(Object.keys(fileDuringStart)).toEqual(["a"]);
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
