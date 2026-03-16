import { logger } from "../logger.js";
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { ErrorResponse, isErrorResponse, TunnelStateType } from "../types.js";
import CLIPrinter from "../utils/printer.js";
import { TunnelResponse, TunnelResponseV2 } from "./handler.js";
import { TunnelConfig, TunnelConfigV1 } from "./remote_schema.js";
import pico from "picocolors";
import type { TunnelOperations } from "./handler.js";

type StartRequestConfig = TunnelConfig | TunnelConfigV1;
type StartResponse = TunnelResponse | TunnelResponseV2 | ErrorResponse;
type ListResponse = TunnelResponse[] | TunnelResponseV2[] | ErrorResponse;
type ListedTunnel = TunnelResponse | TunnelResponseV2;

interface PendingStartEntry {
  configId: string;
  configName: string;
  queuedAt: number;
  tunnelId?: string;
}

const PENDING_START_TIMEOUT_MS = 5 * 60 * 1000;

class RemoteManagementWebSocketPrinter {
  private readonly tunnelManager = TunnelManager.getInstance();
  private readonly pendingStarts = new Map<string, PendingStartEntry>();
  private tunnelHandler?: TunnelOperations;

  setTunnelHandler(tunnelHandler: TunnelOperations) {
    this.tunnelHandler = tunnelHandler;
  }

  queueStart(config: StartRequestConfig) {
    this.cleanupExpiredPendingStarts();
    const entry: PendingStartEntry = {
      configId: this.getConfigIdFromRequest(config),
      configName: this.getConfigNameFromRequest(config),
      queuedAt: Date.now(),
    };
    this.pendingStarts.set(entry.configId, entry);
    CLIPrinter.startSpinner("Starting tunnel with config name: " + entry.configName);
  }

  failQueuedStart(config: StartRequestConfig, reason: string) {
    const configId = this.getConfigIdFromRequest(config);
    const pending = this.pendingStarts.get(configId);
    const configName = pending?.configName || this.getConfigNameFromRequest(config);
    this.pendingStarts.delete(configId);
    CLIPrinter.stopSpinnerFail(`Failed to start tunnel with config name: ${configName}. ${reason}`);
  }

  handleStartResult(config: StartRequestConfig, result: StartResponse) {
    this.cleanupExpiredPendingStarts();

    if (isErrorResponse(result)) {
      this.failQueuedStart(config, result.message);
      return;
    }

    const configId = this.getConfigIdFromTunnel(result);
    const pending = this.pendingStarts.get(configId) || {
      configId,
      configName: this.getConfigNameFromTunnel(result),
      queuedAt: Date.now(),
    };

    pending.tunnelId = result.tunnelid;
    this.pendingStarts.set(configId, pending);

    if (result.remoteurls.length > 0) {
      this.completePendingStart(pending, result.remoteurls);
    }
  }

  printStopRequested(tunnelId: string) {
    const details = this.resolveTunnelDetails(tunnelId);
    CLIPrinter.startSpinner("Stopping tunnel with config name: " + details.configName);
  }

  handleStopResult(tunnelId: string, result: TunnelResponse | ErrorResponse) {
    const details = this.resolveTunnelDetails(tunnelId, result);

    if (isErrorResponse(result)) {
      
      CLIPrinter.stopSpinnerFail("Failed to stop tunnel with config name: " + details.configName);  
      return;
    }

    this.pendingStarts.delete(details.configId);
    CLIPrinter.stopSpinnerSuccess("Stopped tunnel with config name: " + details.configName);
  }

  printRestartRequested(tunnelId: string) {
    const details = this.resolveTunnelDetails(tunnelId);
    CLIPrinter.startSpinner("Restarting tunnel with config name: " + details.configName);
  }

  handleRestartResult(tunnelId: string, result: TunnelResponse | ErrorResponse) {
    const details = this.resolveTunnelDetails(tunnelId, result);

    if (isErrorResponse(result)) {
      CLIPrinter.warn(`Failed to restart tunnel with config name: ${details.configName}. ${result.message}`);
      CLIPrinter.stopSpinnerFail("Failed to restart tunnel with config name: " + details.configName);
      return;
    }

    CLIPrinter.stopSpinnerSuccess("Restarted tunnel with config name: " + details.configName);

    if (result.remoteurls?.length > 0) {
      CLIPrinter.info(pico.cyanBright("Remote URLs:"));
      (result.remoteurls ?? []).forEach((url: string) =>
        CLIPrinter.print("  " + pico.magentaBright(url))
      );
    }
  }

  monitorList(result: ListResponse) {
    this.cleanupExpiredPendingStarts();

    if (!Array.isArray(result) || this.pendingStarts.size === 0) {
      return;
    }

    for (const tunnel of result) {
      const pending = this.findPendingStart(tunnel);
      if (!pending) {
        continue;
      }

      pending.tunnelId = tunnel.tunnelid;
      this.pendingStarts.set(pending.configId, pending);

      if (tunnel.remoteurls.length > 0) {
        this.completePendingStart(pending, tunnel.remoteurls);
        continue;
      }

      if (tunnel.status.state === TunnelStateType.Exited) {
        const reason = tunnel.status.errormsg || "Tunnel exited before a public URL was assigned";
        this.pendingStarts.delete(pending.configId);
        CLIPrinter.stopSpinnerFail(`Tunnel start did not complete for config name: ${pending.configName}. ${reason}`);
      }
    }
  }

  private completePendingStart(entry: PendingStartEntry, urls: string[]) {
    this.pendingStarts.delete(entry.configId);
    CLIPrinter.stopSpinnerSuccess(`Tunnel started with config name: ${entry.configName}.`);
    CLIPrinter.info(pico.cyanBright("Remote URLs:"));
                (urls ?? []).forEach((url: string) =>
                    CLIPrinter.print("  " + pico.magentaBright(url))
                );
  }

  private cleanupExpiredPendingStarts() {
    const now = Date.now();
    for (const [configId, entry] of this.pendingStarts.entries()) {
      if (now - entry.queuedAt <= PENDING_START_TIMEOUT_MS) {
        continue;
      }

      this.pendingStarts.delete(configId);
      CLIPrinter.warn(`Timed out while waiting for tunnel URL for config name: ${entry.configName}`);
      logger.warn("Pending websocket start entry expired", { configId, tunnelId: entry.tunnelId });
    }
  }

  private findPendingStart(tunnel: ListedTunnel): PendingStartEntry | undefined {
    const configId = this.getConfigIdFromTunnel(tunnel);
    const byConfigId = this.pendingStarts.get(configId);
    if (byConfigId) {
      return byConfigId;
    }

    for (const entry of this.pendingStarts.values()) {
      if (entry.tunnelId === tunnel.tunnelid) {
        return entry;
      }
    }

    return undefined;
  }

  private resolveTunnelDetails(tunnelId: string, result?: TunnelResponse | ErrorResponse) {
    try {
      const managed = this.tunnelManager.getManagedTunnel(undefined, tunnelId);
      return {
        configId: managed.configId,
        configName: managed.tunnelName || managed.configId || tunnelId,
      };
    } catch {
      if (result && !isErrorResponse(result)) {
        return {
          configId: this.getConfigIdFromTunnel(result),
          configName: this.getConfigNameFromTunnel(result),
        };
      }

      return {
        configId: tunnelId,
        configName: tunnelId,
      };
    }
  }

  private getConfigIdFromRequest(config: StartRequestConfig): string {
    return "configid" in config ? config.configid : config.configId;
  }

  private getConfigNameFromRequest(config: StartRequestConfig): string {
    return "configname" in config ? config.configname : config.name;
  }

  private getConfigIdFromTunnel(tunnel: ListedTunnel): string {
    return "configid" in tunnel.tunnelconfig ? tunnel.tunnelconfig.configid : tunnel.tunnelconfig.configId;
  }

  private getConfigNameFromTunnel(tunnel: ListedTunnel): string {
    return "configname" in tunnel.tunnelconfig ? tunnel.tunnelconfig.configname : tunnel.tunnelconfig.name;
  }
}

export const remoteManagementWebSocketPrinter = new RemoteManagementWebSocketPrinter();