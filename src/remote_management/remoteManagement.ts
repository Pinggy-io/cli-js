import WebSocket from "ws";
import { logger } from "../logger.js";
import { handleConnectionStatusMessage, WebSocketCommandHandler, WebSocketRequest } from "./websocket_handlers.js";
import CLIPrinter from "../utils/printer.js";
import { loadChalk } from "../utils/esmOnlyPackageLoader.js";
import { RemoteManagementState, RemoteManagementStatus } from "../types.js";

const RECONNECT_SLEEP_MS = 5000; // 5 seconds
const PING_INTERVAL_MS = 30000; // 30 seconds

type RemoteManagementResult =
  | { ok: true }
  | { ok: false; error: unknown };

interface RemoteManagementValues {
  "remote-management"?: string;
  "manage"?: string;
}

let _remoteManagementState: RemoteManagementState = {
  status: "NOT_RUNNING",
  errorMessage: "",
};

let _stopRequested = false;
let currentWs: WebSocket | null = null;

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

export async function parseRemoteManagement(values: RemoteManagementValues): Promise<RemoteManagementResult | void> {
  const rmToken = values["remote-management"];
  if (typeof rmToken === "string" && rmToken.trim().length > 0) {
    const manageHost = values["manage"];
    try {
      await initiateRemoteManagement(rmToken, manageHost);
      return { ok: true };
    } catch (e) {
      logger.error("Failed to initiate remote management:", e);
      return { ok: false, error: e };
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
export async function initiateRemoteManagement(token: string, manage?: string): Promise<RemoteManagementState> {
  await CLIPrinter.ensureDeps();
  await loadChalk();

  if (!token || token.trim().length === 0) {
    throw new Error("Remote management token is required (use --remote-management <TOKEN>)");
  }

  const wsUrl = buildRemoteManagementWsUrl(manage);
  const wsHost = extractHostname(wsUrl);

  logger.info("Remote management mode enabled.");

  // Ensure process exits cleanly on Ctrl+C
  _stopRequested = false;
  const sigintHandler = () => { _stopRequested = true; };
  process.once('SIGINT', sigintHandler);

  const logConnecting = () => {
    CLIPrinter.print(`Connecting to ${wsHost}`);
    logger.info("Connecting to remote management", { wsUrl });
  }


  while (!_stopRequested) {
    logConnecting();
    setRemoteManagementState({ status: RemoteManagementStatus.Connecting, errorMessage: "" });
    try {
      await handleWebSocketConnection(wsUrl, wsHost, token);
    } catch (error) {
      logger.warn("Remote management connection error", { error: String(error) });

    }
    if (_stopRequested) break;
    CLIPrinter.warn(`Remote management disconnected. Reconnecting in ${RECONNECT_SLEEP_MS / 1000} seconds...`);
    logger.info("Reconnecting to remote management after disconnect");
    await sleep(RECONNECT_SLEEP_MS);
  }


  process.removeListener('SIGINT', sigintHandler);
  logger.info("Remote management stopped.");
  return getRemoteManagementState();
}

async function handleWebSocketConnection(wsUrl: string, wsHost: string, token: string): Promise<void> {
  return new Promise<void>((resolve) => {

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Tracking the ws for cleanup
    currentWs = ws;

    let heartbeat: NodeJS.Timeout | null = null;
    let firstMessage = true;

    /** Safely cleanup on any exit */
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      currentWs = null;
      resolve();
    };

    ws.once("open", () => {
      CLIPrinter.success(`Connected to ${wsHost}`);

      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
    });

    ws.on("ping", () => ws.pong());

    ws.on("message", async (data) => {
      try {
        if (firstMessage) {
          firstMessage = false;
          const ok = handleConnectionStatusMessage(data);
          if (!ok) ws.close();
          return;
        }
        setRemoteManagementState({ status: RemoteManagementStatus.Running, errorMessage: "" });
        const req = JSON.parse(data.toString("utf8")) as WebSocketRequest;
        await new WebSocketCommandHandler().handle(ws, req);
      } catch (e) {
        logger.warn("Failed handling websocket message", { error: String(e) });
      }
    });

    ws.on("unexpected-response", (_, res) => {
      setRemoteManagementState({ status: RemoteManagementStatus.NotRunning, errorMessage: `HTTP ${res.statusCode}` });
      if (res.statusCode === 401) {
        CLIPrinter.error("Unauthorized. Please enter a valid token.");
        logger.error("Unauthorized (401) on remote management connect");
      } else {
        CLIPrinter.warn(`Unexpected HTTP ${res.statusCode}. Retrying...`);
        logger.warn("Unexpected HTTP response", { statusCode: res.statusCode });
      }
      ws.close();
    });

    ws.on("close", (code, reason) => {
      setRemoteManagementState({ status: RemoteManagementStatus.NotRunning, errorMessage: "" });
      logger.info("WebSocket closed", { code, reason: reason.toString() });
      CLIPrinter.warn(`Disconnected (code: ${code}). Retrying...`);
      cleanup();
    });

    ws.on("error", (err) => {
      setRemoteManagementState({ status: RemoteManagementStatus.Error, errorMessage: err.message });
      logger.warn("WebSocket error", { error: err.message });
      CLIPrinter.error(err);
      cleanup();
    });
  });

}

export async function closeRemoteManagement(timeoutMs = 10000): Promise<RemoteManagementState> {
  _stopRequested = true;
  try {
    if (currentWs) {
      try {
        setRemoteManagementState({ status: RemoteManagementStatus.Disconnecting, errorMessage: "" });
        currentWs.close();
      } catch (e) {
        logger.warn("Error while closing current remote management websocket", { error: String(e) });
      }
    }

    const start = Date.now();
    while (_remoteManagementState.status === "RUNNING") {
      if (Date.now() - start > timeoutMs) {
        logger.warn("Timed out waiting for remote management to stop");
        break;
      }
      await sleep(200);
    }
  } finally {
    // Ensure ws ref cleared
    currentWs = null;
    setRemoteManagementState({ status: RemoteManagementStatus.NotRunning, errorMessage: "" });
    return getRemoteManagementState();
  }
}


export function getRemoteManagementState(): RemoteManagementState {
  return _remoteManagementState;
}

function setRemoteManagementState(state: RemoteManagementState, errorMessage?: string) {
  _remoteManagementState = {
    status: state.status,
    errorMessage: errorMessage || "",
  };
}
