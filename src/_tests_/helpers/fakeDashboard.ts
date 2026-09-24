import { WebSocketServer, WebSocket as ServerSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * A dashboard the device agent can actually dial, for the behaviour that only exists on a live
 * socket: handshake, close codes, ping and pong.
 *
 * Every test drives it from the server side, because that is the only place the agent's decisions
 * are observable. The agent itself exposes nothing but a promise that resolves when its loop ends.
 */

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 1;

/** The device id the fake dashboard mints. Stable, so identity assertions can name it. */
export const FAKE_DEVICE_AGENT_ID = '11111111-2222-3333-4444-555555555555';

function frame(op: string, kind: string, payload: unknown): string {
    return JSON.stringify({
        v: 1, kind, ch: 'system', op, id: '', seq: 0,
        ts: Math.floor(Date.now() / 1000), payload,
    });
}

export function welcomeFrame(heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS): string {
    return frame('welcome', 'res', {
        device_agent_id: FAKE_DEVICE_AGENT_ID,
        accepted_proto: 1,
        heartbeat_interval_seconds: heartbeatIntervalSeconds,
        stats_interval_seconds: 60,
        server_time: Math.floor(Date.now() / 1000),
        max_frame_bytes: 32768,
        terminal_window_bytes: 262144,
    });
}

export function disconnectFrame(reason: string): string {
    return frame('disconnect', 'event', { reason });
}

/** A handshake refusal, which the dashboard answers on welcome rather than on hello. */
export function helloErrorFrame(code: string, message: string): string {
    return frame('welcome', 'res', { error: { code, message } });
}

export interface FakeConnection {
    /** 1-based, so a test can say "the second dial". */
    readonly index: number;
    readonly socket: ServerSocket;
    /** Pings this connection received. The agent sends them; a silent server answers none. */
    pings: number;
    send(raw: string): void;
    close(code: number, reason?: string): void;
    /**
     * Kills the connection with no close handshake, the way a lost link does. 1006 cannot be sent
     * on the wire: it is a status the local end reports, and `ws` refuses it as a close code.
     */
    drop(): void;
}

/** Runs once per accepted upgrade, when hello arrives, with the hello payload. */
export type OnHello = (connection: FakeConnection, hello: Record<string, unknown>) => void;

/** Runs for every frame the agent sends after hello. */
export type OnFrame = (connection: FakeConnection, frame: Record<string, unknown>) => void;

function wireConnection(socket: ServerSocket, index: number, onHello?: OnHello, onFrame?: OnFrame): FakeConnection {
    const connection: FakeConnection = {
        index,
        socket,
        pings: 0,
        send: (raw) => {
            if (socket.readyState === socket.OPEN) socket.send(raw);
        },
        close: (code, reason) => socket.close(code, reason),
        drop: () => socket.terminate(),
    };

    socket.on('ping', () => { connection.pings += 1; });
    socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed.op === 'hello') {
            onHello?.(connection, parsed.payload ?? {});
        } else {
            onFrame?.(connection, parsed);
        }
    });

    return connection;
}

export interface FakeDashboard {
    readonly url: string;
    /** Completed upgrades so far. */
    connections(): number;
    close(): void;
}

export interface FakeDashboardOptions {
    /**
     * Off makes the server receive every ping and answer none, which is what a half-dead link looks
     * like: the socket stays open and nothing ever closes it.
     */
    autoPong?: boolean;
    /** Omit to accept the socket and stay silent, which is the stalled-handshake case. */
    onHello?: OnHello;
    onFrame?: OnFrame;
}

export async function startFakeDashboard(options: FakeDashboardOptions = {}): Promise<FakeDashboard> {
    const server = new WebSocketServer({
        port: 0, host: '127.0.0.1', autoPong: options.autoPong ?? true,
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    let connectionCount = 0;

    server.on('connection', (socket: ServerSocket) => {
        connectionCount += 1;
        wireConnection(socket, connectionCount, options.onHello, options.onFrame);
    });

    return {
        url: `ws://127.0.0.1:${port}`,
        connections: () => connectionCount,
        close: () => server.close(),
    };
}

export interface RefusingDashboard {
    readonly url: string;
    /** Upgrade requests received, refused or not. A terminal outcome means this stays at 1. */
    attempts(): number;
    /** Upgrades that completed, which is 0 unless refuseFirst was set. */
    connections(): number;
    close(): void;
}

export interface RefusingDashboardOptions {
    /** Upgrades to refuse before accepting. Omit to refuse every one. */
    refuseFirst?: number;
    onHello?: OnHello;
}

/**
 * Refuses the upgrade with a status code, before any WebSocket exists.
 *
 * This needs a raw http server: the refusal happens on the upgrade request itself, which is the
 * whole point of a 401 here. `noServer` then lets the accepted ones through to `ws`.
 */
export async function startRefusingDashboard(statusCode: number,
                                             options: RefusingDashboardOptions = {}): Promise<RefusingDashboard> {
    const server = http.createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const refuseFirst = options.refuseFirst ?? Infinity;
    const crlf = String.fromCharCode(13, 10);

    let attemptCount = 0;
    let connectionCount = 0;

    server.on('upgrade', (request, socket, head) => {
        attemptCount += 1;

        if (attemptCount > refuseFirst) {
            webSocketServer.handleUpgrade(request, socket as never, head, (accepted) => {
                connectionCount += 1;
                wireConnection(accepted, connectionCount, options.onHello);
            });
            return;
        }

        socket.write(`HTTP/1.1 ${statusCode} Refused${crlf}Connection: close${crlf}${crlf}`);
        socket.destroy();
    });

    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `ws://127.0.0.1:${port}`,
        attempts: () => attemptCount,
        connections: () => connectionCount,
        close: () => {
            webSocketServer.close();
            server.close();
        },
    };
}

/**
 * Points the config dir at a temp directory for the life of a suite.
 *
 * Without this every test that reaches welcome would rewrite the developer's own
 * ~/.config/pinggy/device.json, which holds a live credential.
 */
export function redirectConfigHome(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-device-test-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;

    process.env.XDG_CONFIG_HOME = dir;
    process.env.APPDATA = dir;

    return {
        dir,
        cleanup: () => {
            if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousXdg;
            if (previousAppData === undefined) delete process.env.APPDATA;
            else process.env.APPDATA = previousAppData;
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Strips the colour picocolors adds, so an assertion can match the sentence. */
export function plain(text: string): string {
    const escape = String.fromCharCode(27);
    return text.replace(new RegExp(`${escape}\\[[0-9;]*m`, 'g'), '');
}
