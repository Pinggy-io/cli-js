
import { useEffect, useRef, useState } from "react";
import WebSocket from "ws";
import { ReqResPair, WebDebuggerSocketRequest } from "../../../types.js";
import { logger } from "../../../logger.js";

export function useWebDebugger(webDebuggerUrl?: string) {
  const [pairs, setPairs] = useState<Map<number, ReqResPair>>(new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!webDebuggerUrl) return;

    let isStopped = false;

    const connect = () => {
      const ws = new WebSocket(`ws://${webDebuggerUrl}/introspec/websocket`);
      socketRef.current = ws;

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

          setPairs((prev) => {
            const newMap = new Map(prev);

            if (msg.Req) {
              const { key } = msg.Req;
              const existing = newMap.get(key) as ReqResPair | undefined;
              const merged = {

                request: msg.Req,
                response: existing?.response,
                reqHeaders: existing?.reqHeaders ?? {},
                resHeaders: existing?.resHeaders ?? {},
                headersLoaded: existing?.headersLoaded ?? false,
              } as ReqResPair;
              newMap.set(key, merged);
            }

            if (msg.Res) {
              const { key } = msg.Res;
              const existing = newMap.get(key) as ReqResPair | undefined;
              const merged = {
                
                request: existing?.request ?? ({} as any),
                response: msg.Res,
                reqHeaders: existing?.reqHeaders ?? {},
                resHeaders: existing?.resHeaders ?? {},
                headersLoaded: existing?.headersLoaded ?? false,
              } as ReqResPair;
              newMap.set(key, merged);
            }

            return newMap;
          });
        } catch (err: any) {
          logger.error("Error parsing WebSocket message:", err.message || err);
        }
      });

      ws.on("close", () => {
        logger.warn("Web debugger disconnected. Reconnecting in 5s...");
        if (!isStopped) {
          reconnectTimeout.current = setTimeout(connect, 5000);
        }
      });

      ws.on("error", (err) => {
        logger.error(`WebSocket error: ${err.message}`);
      });
    };

    connect();

    return () => {
      isStopped = true;
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
    };
  }, [webDebuggerUrl]);

  return { pairs };
}
