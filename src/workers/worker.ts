import { parentPort, workerData } from "node:worker_threads";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { FinalConfig } from "../types.js";
import { logger } from "../logger.js";


if (!parentPort) {
  throw new Error("This file should only be run as a Worker");
}

const port = parentPort!;

(async () => {
  try {
    const manager = TunnelManager.getInstance();
    type WorkerPayload = {
      finalConfig: FinalConfig;
    };

    function assertWorkerPayload(x: unknown): asserts x is WorkerPayload {
      if (!x || typeof x !== "object") throw new Error("Invalid workerData");
      const d = x as any;
      if (!d.finalConfig) throw new Error("workerData.finalConfig missing");
    }

    assertWorkerPayload(workerData);
    const { finalConfig } = workerData as WorkerPayload;

    // Initialize tunnel
    const tunnel = manager.createTunnel(finalConfig);
    port.postMessage({ type: "created", message: "Connecting to Pinggy...\n" });


    // Listen for tunnel usage updates
    manager.registerStatsListener(tunnel.tunnelid, (tunnelID, usage) => {
      port.postMessage({ type: "usage", usage });
    });

    manager.registerErrorListener(tunnel.tunnelid, (tunnelID, error) => {
      
      port.postMessage({ type: "error", error: error });
    });

    manager.registerDisconnectListener(tunnel.tunnelid, (tunnelID, error, messages) => {
      
      port.postMessage({ type: "disconnected", error: error, messages: messages });
    });


    // Start the tunnel
    await manager.startTunnel(tunnel.tunnelid);

    // Notify success
    port.postMessage({ type: "started", message: "Connected to Pinggy...\n" });

    // send greetmsg
    const greetMsg = manager.getTunnelGreetMessage(tunnel.tunnelid);
    if (greetMsg) {
      port.postMessage({ type: "greetmsg", message: greetMsg });
    }

    // send tunnel URLs
    const urls = manager.getTunnelUrls(tunnel.tunnelid);
    if (urls) {
      port.postMessage({ type: "urls", urls });
    }

    // startTui if enabled
    port.postMessage({ type: "TUI", message: "Initiating TUI" });
    
    if (tunnel.warnings && tunnel.warnings?.length > 0) {
      port.postMessage({ type: "warnings", warnings: tunnel.warnings });
    }
    // Listen for messages from main thread
    port.on("message", (msg) => {
      if (msg?.type === "stop") {
        manager.stopTunnel(tunnel.tunnelid);
        port.postMessage({ type: "status", message: "Tunnel stopped by main thread" });
        process.exit(0);
      }
    });
  } catch (err: any) {
    logger.error("Worker encountered an error:", err);
    port.postMessage({ type: "error", error: err?.message || String(err) });
    process.exit(1);
  }
})();
