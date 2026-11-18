import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { WsStream } from "../daemon/ws/wsStream.js";
import { SessionMode } from "../daemon/ipc/ipcRoutes.js";

/**
 * After a daemon restart the client subscribes again for every tunnel at once, before its new socket
 * is open. All of those must go out on 1 socket, and none may be skipped as "already subscribed".
 */

let server: WebSocketServer;
let connections = 0;
let frames: Array<{ type: string; tunnelId: string }> = [];
let stream: WsStream;

beforeEach(async () => {
    connections = 0;
    frames = [];
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("connection", (socket) => {
        connections += 1;
        socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    stream = new WsStream(() => `ws://127.0.0.1:${port}`);
});

afterEach(async () => {
    stream.terminate();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitForFrames(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && frames.length < count; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("WsStream.subscribe", () => {
    test("subscribes made before the socket is open share that socket", async () => {
        await Promise.all([
            stream.subscribe("tunnel-a", SessionMode.Detached),
            stream.subscribe("tunnel-b", SessionMode.Detached),
            stream.subscribe("tunnel-c", SessionMode.Detached),
        ]);
        await waitForFrames(3);

        expect(connections).toBe(1);
        expect(frames.map((frame) => frame.tunnelId).sort()).toEqual(["tunnel-a", "tunnel-b", "tunnel-c"]);
        expect(frames.every((frame) => frame.type === "subscribe")).toBe(true);
    });

    test("a subscribe after the daemon died is sent to the new daemon", async () => {
        await stream.subscribe("tunnel-a", SessionMode.Detached);
        await waitForFrames(1);

        // The daemon dies: the socket closes, then the client declares the daemon lost.
        for (const client of server.clients) client.terminate();
        for (let attempt = 0; attempt < 100 && stream.isOpen(); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        stream.terminate();
        expect(stream.isSubscribed("tunnel-a")).toBe(false);

        await stream.subscribe("tunnel-a", SessionMode.Detached);
        await waitForFrames(2);

        expect(connections).toBe(2);
        expect(frames.map((frame) => frame.tunnelId)).toEqual(["tunnel-a", "tunnel-a"]);
    });
});
