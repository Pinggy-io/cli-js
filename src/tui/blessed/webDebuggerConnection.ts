import WebSocket from "ws";
import { ReqResPair, WebDebuggerSocketRequest } from "../../types.js";
import { logger } from "../../logger.js";

export interface WebDebuggerConnection {
    close: () => void;
}

export function createWebDebuggerConnection(
    webDebuggerUrl: string,
    onUpdate: (pairs: Map<number, ReqResPair>) => void
): WebDebuggerConnection {
    const pairs = new Map<number, ReqResPair>();
    let socket: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let isStopped = false;

    const connect = () => {
        const ws = new WebSocket(`ws://${webDebuggerUrl}/introspec/websocket`);
        socket = ws;

        ws.on("open", () => {
            logger.info("Web debugger connected.");
        });

        ws.on("message", (data) => {
            try {
                const raw = data.toString();
                const parsed = JSON.parse(raw);
                const msg = {
                    Req: parsed.Req || parsed.req,
                    Res: parsed.Res || parsed.res,
                } as Partial<WebDebuggerSocketRequest>;

                if (msg.Req) {
                    const { key } = msg.Req;
                    const existing = pairs.get(key) as ReqResPair | undefined;
                    const merged: ReqResPair = {
                        request: msg.Req,
                        response: existing?.response,
                        reqHeaders: existing?.reqHeaders ?? {},
                        resHeaders: existing?.resHeaders ?? {},
                        headersLoaded: existing?.headersLoaded ?? false,
                    } as ReqResPair;
                    pairs.set(key, merged);
                }

                if (msg.Res) {
                    const { key } = msg.Res;
                    const existing = pairs.get(key) as ReqResPair | undefined;
                    const merged: ReqResPair = {
                        request: existing?.request ?? ({} as any),
                        response: msg.Res,
                        reqHeaders: existing?.reqHeaders ?? {},
                        resHeaders: existing?.resHeaders ?? {},
                        headersLoaded: existing?.headersLoaded ?? false,
                    } as ReqResPair;
                    pairs.set(key, merged);
                }

                // Notify listener with a copy of the pairs map
                onUpdate(new Map(pairs));
            } catch (err: any) {
                logger.error("Error parsing WebSocket message:", err.message || err);
            }
        });

        ws.on("close", () => {
            logger.warn("Web debugger disconnected. Reconnecting in 5s...");
            if (!isStopped) {
                reconnectTimeout = setTimeout(connect, 5000);
            }
        });

        ws.on("error", (err) => {
            logger.error(`WebSocket error: ${err.message}`);
        });
    };

    connect();

    return {
        close: () => {
            isStopped = true;
            if (socket) {
                socket.close();
            }
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
        },
    };
}
