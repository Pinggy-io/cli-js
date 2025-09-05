import WebSocket from "ws";
import { logger } from "../logger";
import { handleConnectionStatusMessage, WebSocketCommandHandler, WebSocketRequest } from "./websocket_handlers";

const RECONNECT_SLEEP_MS = 5000; // 5 seconds
const PING_INTERVAL_MS = 30000; // 30 seconds


export function buildRemoteManagementWsUrl(manage?: string): string {
  let baseUrl = (manage || "dashboard.pinggy.io").trim();
  if (!(baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://"))) {
    baseUrl = "wss://" + baseUrl;
  }
  // Avoid duplicate slashes when concatenating
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/backend/api/v1/remote-management/connect`;
}

function extractHostname(u: string): string {
  try {
    const url = new URL(u);
    return url.host;
  } catch {
    return u;
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function parseRemoteManagement(values: Record<string, unknown>) {
  const rmToken = (values as any)["remote-management"] as string | undefined;
  if (typeof rmToken === 'string' && rmToken.trim().length > 0) {
    const manageHost = (values as any)["manage"] as string | undefined;
    try {
      await initiateRemoteManagement(rmToken, manageHost);
      return; // Exit after initiating remote management
    } catch (e) {
      logger.error("Failed to initiate remote management:", e);
      return { Error: e };
    }
  }
}

/**
 * Initiate remote management mode with a WebSocket connection.
 * - Connect with Authorization: Bearer <token>
 * - On HTTP 401: print Unauthorized and exit
 * - On other failures: retry every 15 seconds
 * - Keep running until closed or SIGINT
 */
export async function initiateRemoteManagement(token: string, manage?: string): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw new Error("Remote management token is required (use --remote-management <TOKEN>)");
  }

  const wsUrl = buildRemoteManagementWsUrl(manage);
  const wsHost = extractHostname(wsUrl);

  logger.info("Remote management mode enabled.");

  // Ensure process exits cleanly on Ctrl+C
  let stopRequested = false;
  const sigintHandler = () => { stopRequested = true; };
  process.once('SIGINT', sigintHandler);

  let firstTry = true;
  while (!stopRequested) {
    if (firstTry) {
      firstTry = false;
      console.log(`Connecting to ${wsHost}`);
      logger.info("Connecting to remote management", { wsUrl });
    } else {
      console.log(`Reconnecting in ${RECONNECT_SLEEP_MS / 1000} seconds.`);
      logger.info("Reconnecting after sleep", { seconds: RECONNECT_SLEEP_MS / 1000 });
      await sleep(RECONNECT_SLEEP_MS);
      if (stopRequested) break;
      console.log(`Connecting to ${wsHost}`);
      logger.info("Connecting to remote management", { wsUrl });
    }

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    await new Promise<void>((resolve) => {
      let heartbeat: NodeJS.Timeout;

      const startHeartbeat = () => {
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.ping(); // ask server for pong
        }, PING_INTERVAL_MS);
      };

      ws.on("open", () => {
        console.log(`Connected to ${wsHost}`);
        startHeartbeat();
      });

      // Respond to server pings
      ws.on("ping", () => ws.pong());

      let firstMessage = true;
      ws.on('message', async (data: WebSocket.Data) => {
        try {
          if (firstMessage) {
            firstMessage = false;
            console.log("First msg", data.toString("utf-8"));
            const ok = handleConnectionStatusMessage(data);
            if (!ok) {
              // The status message itself indicates failure, so close and retry.
              ws.close();
            }
            return; // Wait for the next message (commands)
          }
          const text = data.toString('utf8');
          console.log("WebSocket message received", { text });
          const req = JSON.parse(text) as WebSocketRequest;
          console.log("req in management", req);
          const webSocketHandler = new WebSocketCommandHandler();
          await webSocketHandler.handle(ws, req);
        } catch (e) {
          logger.warn("Failed handling websocket message", { error: String(e) });
        }
      });

      ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          console.error("Unauthorized. Please enter a valid token.");
          logger.error("Unauthorized (401) on remote management connect");
          stopRequested = true; // Mark to stop retrying
          ws.close(); // This will trigger 'close' and resolve the promise
        } else {
          logger.warn("Unexpected HTTP response on WebSocket connect", { statusCode: res.statusCode });
          ws.close(); // Trigger 'close' to retry
        }
      });

      ws.on('close', (code, reason) => {
        logger.info("WebSocket closed", { code, reason: reason.toString() });
        console.log("Connection closed.");
        clearInterval(heartbeat);
        resolve(); // End the promise, allowing the while loop to continue
      });

      ws.on('error', (err) => {
        logger.warn("WebSocket error", { error: err.message });
        clearInterval(heartbeat);
        resolve(); // End the promise, allowing the while loop to continue
      });
    });

    if (stopRequested) break;
  }

  process.removeListener('SIGINT', sigintHandler);
  logger.info("Remote management stopped.");
}
