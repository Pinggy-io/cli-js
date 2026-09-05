import { randomUUID } from "crypto";

/**
 * The versioned wrapper every device agent frame travels in.
 *
 * Mirrors DeviceAgentEnvelope on the dashboard side. See
 * docs/pinggy-devices/api-websocket.md.
 */
export const PROTOCOL_VERSION = 1;

export const CHANNEL_SYSTEM = "system";
export const CHANNEL_DEVICE = "device";

export const OP_HELLO = "hello";
export const OP_WELCOME = "welcome";
export const OP_HEARTBEAT = "heartbeat";
export const OP_DISCONNECT = "disconnect";

export type FrameKind = "req" | "res" | "event";

export interface Envelope {
    v: number;
    kind: FrameKind;
    ch: string;
    op: string;
    id: string;
    seq: number;
    ts: number;
    payload: unknown;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

export function request(ch: string, op: string, payload: unknown): Envelope {
    return { v: PROTOCOL_VERSION, kind: "req", ch, op, id: randomUUID(), seq: 0, ts: nowSeconds(), payload };
}

export function event(ch: string, op: string, payload: unknown): Envelope {
    return { v: PROTOCOL_VERSION, kind: "event", ch, op, id: "", seq: 0, ts: nowSeconds(), payload };
}

/**
 * Returns null rather than throwing on anything unparseable.
 *
 * An unrecognised frame must never drop the connection: a forward-compatible protocol cannot
 * require dashboard and agent to deploy in lockstep.
 */
export function parseEnvelope(raw: string): Envelope | null {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        if (typeof parsed.ch !== "string" || typeof parsed.op !== "string") return null;
        return parsed as Envelope;
    } catch {
        return null;
    }
}
