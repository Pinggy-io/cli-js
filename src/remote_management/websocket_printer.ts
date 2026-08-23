import { logger } from "../logger.js";
import { ErrorResponse, isErrorResponse, TunnelStateType } from "../types.js";
import CLIPrinter from "../utils/printer.js";
import { TunnelResponse, TunnelResponseV2 } from "./handler.js";
import { TunnelConfig, TunnelConfigV1 } from "./remote_schema.js";
import pico from "picocolors";

type StartRequestConfig = TunnelConfig | TunnelConfigV1;
type StartResponse = TunnelResponse | TunnelResponseV2 | ErrorResponse;
type ListResponse = TunnelResponse[] | TunnelResponseV2[] | ErrorResponse;
type ListedTunnel = TunnelResponse | TunnelResponseV2;

interface PendingEntry {
  configId: string;
  configName: string;
  queuedAt: number;
  tunnelId?: string;
}

type PendingActionType = "restart" | "update";

interface PendingActionEntry extends PendingEntry {
  action: PendingActionType;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Map plus latest-request cursor shared by start and restart/update tracking.
 * Only the latest queued request owns the spinner; older entries are tracked
 * but never print.
 */
class PendingTracker<T extends PendingEntry> {
  private readonly entries = new Map<string, T>();
  private latestConfigId?: string;

  queue(entry: T) {
    this.latestConfigId = entry.configId;
    this.entries.set(entry.configId, entry);
  }

  /** Store an entry without claiming the latest cursor. */
  upsert(entry: T) {
    this.entries.set(entry.configId, entry);
  }

  get(configId: string): T | undefined {
    return this.entries.get(configId);
  }

  find(configId: string, tunnelId?: string): T | undefined {
    const byConfigId = this.entries.get(configId);
    if (byConfigId) {
      return byConfigId;
    }
    if (!tunnelId) {
      return undefined;
    }
    for (const entry of this.entries.values()) {
      if (entry.tunnelId === tunnelId) {
        return entry;
      }
    }
    return undefined;
  }

  delete(configId: string) {
    this.entries.delete(configId);
    if (this.latestConfigId === configId) {
      this.latestConfigId = undefined;
    }
  }

  get latest(): string | undefined {
    return this.latestConfigId;
  }

  get hasLatest(): boolean {
    return this.entries.size > 0 && this.latestConfigId !== undefined;
  }

  isLatest(configId: string): boolean {
    return configId === this.latestConfigId;
  }

  cleanupExpired(onTimeout: (entry: T, wasLatest: boolean) => void) {
    const now = Date.now();
    for (const [configId, entry] of this.entries) {
      if (now - entry.queuedAt <= PENDING_TIMEOUT_MS) {
        continue;
      }
      const wasLatest = this.isLatest(configId);
      this.delete(configId);
      onTimeout(entry, wasLatest);
    }
  }
}

class RemoteManagementWebSocketPrinter {
  private readonly pendingStarts = new PendingTracker<PendingEntry>();
  private readonly pendingActions = new PendingTracker<PendingActionEntry>();
  // tunnelId -> details, fed by monitorList. Stop/restart requests only carry
  // a tunnelId; without this the spinner shows the raw id.
  private readonly tunnelDetailsCache = new Map<string, { configId: string; configName: string }>();

  queueStart(config: StartRequestConfig) {
    this.cleanupExpiredPendingStarts();

    const entry: PendingEntry = {
      configId: this.getConfigIdFromRequest(config),
      configName: this.getConfigNameFromRequest(config),
      queuedAt: Date.now(),
    };
    this.pendingStarts.queue(entry);

    CLIPrinter.startSpinner("Starting tunnel with config name: " + entry.configName);
  }

  failQueuedStart(config: StartRequestConfig, reason: string) {
    const configId = this.getConfigIdFromRequest(config);
    const pending = this.pendingStarts.get(configId);
    const configName = pending?.configName || this.getConfigNameFromRequest(config);
    const wasLatest = this.pendingStarts.isLatest(configId);
    this.pendingStarts.delete(configId);

    if (wasLatest) {
      CLIPrinter.stopSpinnerFail(`Failed to start tunnel with config name: ${configName}. ${reason}`);
    }
  }

  handleStartResult(config: StartRequestConfig, result: StartResponse) {
    this.cleanupExpiredPendingStarts();

    const requestedConfigId = this.getConfigIdFromRequest(config);

    // Ignore old start requests; only last one should print
    if (this.pendingStarts.latest && !this.pendingStarts.isLatest(requestedConfigId)) {
      this.pendingStarts.delete(requestedConfigId);
      return;
    }

    if (isErrorResponse(result)) {
      this.failQueuedStart(config, result.message);
      return;
    }

    const pending = this.pendingStarts.get(requestedConfigId) || {
      configId: requestedConfigId,
      configName: this.getConfigNameFromRequest(config),
      queuedAt: Date.now(),
    };
    pending.tunnelId = result.tunnelid;
    this.pendingStarts.upsert(pending);

    if (result.remoteurls.length > 0) {
      this.completePendingStart(pending, result.remoteurls);
    }
  }

  printStopRequested(tunnelId: string) {
    const details = this.resolveTunnelDetails(tunnelId);
    this.clearPendingAction(details.configId, tunnelId);
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
    this.clearPendingAction(details.configId, tunnelId);
    CLIPrinter.startSpinner("Restarting tunnel with config name: " + details.configName);
  }

  handleRestartResult(tunnelId: string, result: TunnelResponse | ErrorResponse) {
    const details = this.resolveTunnelDetails(tunnelId, result);

    if (isErrorResponse(result)) {
      CLIPrinter.warn(`Failed to restart tunnel with config name: ${details.configName}. ${result.message}`);
      CLIPrinter.stopSpinnerFail("Failed to restart tunnel with config name: " + details.configName);
      return;
    }

    this.queuePendingAction("restart", details.configId, details.configName, result.tunnelid);
  }

  printUpdateConfigRequested(config: StartRequestConfig) {
    const configName = this.getConfigNameFromRequest(config);
    this.clearPendingAction(this.getConfigIdFromRequest(config));
    CLIPrinter.startSpinner("Updating tunnel configuration for: " + configName);
  }

  handleUpdateConfigResult(config: StartRequestConfig, result: StartResponse) {
    const configId = this.getConfigIdFromRequest(config);
    const configName = this.getConfigNameFromRequest(config);

    if (isErrorResponse(result)) {
      CLIPrinter.stopSpinnerFail(`Failed to update tunnel configuration for: ${configName}. ${result.message}`);
      return;
    }

    if (result.status.state === TunnelStateType.Exited) {
      CLIPrinter.stopSpinnerSuccess(`Tunnel configuration updated: ${configName}.`);
      return;
    }

    this.queuePendingAction("update", configId, configName, result.tunnelid);
  }

  private clearPendingAction(configId: string, tunnelId?: string) {
    const entry = this.pendingActions.find(configId, tunnelId);
    if (!entry) {
      return;
    }
    this.pendingActions.delete(entry.configId);
  }


  private queuePendingAction(action: PendingActionType, configId: string, configName: string, tunnelId: string) {
    this.cleanupExpiredPendingActions();
    this.pendingActions.queue({ action, configId, configName, queuedAt: Date.now(), tunnelId });
  }

  private printActionComplete(action: PendingActionType, configName: string, urls: string[]) {
    const message = action === "restart"
      ? `Restarted tunnel with config name: ${configName}`
      : `Tunnel configuration updated and restarted: ${configName}`;
    CLIPrinter.stopSpinnerSuccess(message);
    CLIPrinter.info(pico.cyanBright("Remote URLs:"));
    urls.forEach((url: string) => CLIPrinter.print("  " + pico.magentaBright(url)));
  }

  monitorList(result: ListResponse) {
    this.cleanupExpiredPendingStarts();
    this.cleanupExpiredPendingActions();

    if (!Array.isArray(result)) {
      return;
    }

    for (const tunnel of result) {
      this.tunnelDetailsCache.set(tunnel.tunnelid, {
        configId: this.getConfigIdFromTunnel(tunnel),
        configName: this.getConfigNameFromTunnel(tunnel),
      });
    }

    this.resolvePendingFromList(result, this.pendingStarts,
      (entry, urls) => this.completePendingStart(entry, urls),
      (entry, reason) => CLIPrinter.stopSpinnerFail(`Tunnel start did not complete for config name: ${entry.configName}. ${reason}`)
    );

    this.resolvePendingFromList(result, this.pendingActions,
      (entry, urls) => {
        this.pendingActions.delete(entry.configId);
        this.printActionComplete(entry.action, entry.configName, urls);
      },
      (entry, reason) => {
        const verb = entry.action === "restart" ? "Restart" : "Configuration update";
        CLIPrinter.stopSpinnerFail(`${verb} did not complete for config name: ${entry.configName}. ${reason}`);
      }
    );
  }


  private resolvePendingFromList<T extends PendingEntry>(
    tunnels: ListedTunnel[],
    tracker: PendingTracker<T>,
    onComplete: (entry: T, urls: string[]) => void,
    onExited: (entry: T, reason: string) => void,
  ) {
    if (!tracker.hasLatest) {
      return;
    }

    for (const tunnel of tunnels) {
      const entry = tracker.find(this.getConfigIdFromTunnel(tunnel), tunnel.tunnelid);
      if (!entry || !tracker.isLatest(entry.configId)) {
        continue;
      }

      entry.tunnelId = tunnel.tunnelid;
      tracker.upsert(entry);

      if (tunnel.remoteurls.length > 0) {
        onComplete(entry, tunnel.remoteurls);
        continue;
      }

      if (tunnel.status.state === TunnelStateType.Exited) {
        tracker.delete(entry.configId);
        onExited(entry, tunnel.status.errormsg || "Tunnel exited before a public URL was assigned");
      }
    }
  }

  private completePendingStart(entry: PendingEntry, urls: string[]) {
    // Guard: print only for latest requested start
    if (this.pendingStarts.latest && !this.pendingStarts.isLatest(entry.configId)) {
      this.pendingStarts.delete(entry.configId);
      return;
    }

    this.pendingStarts.delete(entry.configId);

    CLIPrinter.stopSpinnerSuccess(`Tunnel started with config name: ${entry.configName}.`);
    CLIPrinter.info(pico.cyanBright("Remote URLs:"));
    (urls ?? []).forEach((url: string) =>
      CLIPrinter.print("  " + pico.magentaBright(url))
    );
  }

  private cleanupExpiredPendingStarts() {
    this.pendingStarts.cleanupExpired((entry, wasLatest) => {
      const message = `Timed out while waiting for tunnel URL for config name: ${entry.configName}`;
      if (wasLatest) {
        CLIPrinter.stopSpinnerFail(message);
      } else {
        CLIPrinter.warn(message);
      }
      logger.warn("Pending websocket start entry expired", { configId: entry.configId, tunnelId: entry.tunnelId });
    });
  }

  private cleanupExpiredPendingActions() {
    this.pendingActions.cleanupExpired((entry, wasLatest) => {
      const verb = entry.action === "restart" ? "restart" : "configuration update";
      const message = `Timed out while waiting for tunnel URL after ${verb} for config name: ${entry.configName}`;
      if (wasLatest) {
        CLIPrinter.stopSpinnerFail(message);
      } else {
        CLIPrinter.warn(message);
      }
      logger.warn("Pending websocket action entry expired", { configId: entry.configId, tunnelId: entry.tunnelId, action: entry.action });
    });
  }

  private resolveTunnelDetails(tunnelId: string, result?: TunnelResponse | ErrorResponse) {
    if (result && !isErrorResponse(result)) {
      return {
        configId: this.getConfigIdFromTunnel(result),
        configName: this.getConfigNameFromTunnel(result),
      };
    }

    return this.tunnelDetailsCache.get(tunnelId) ?? {
      configId: tunnelId,
      configName: tunnelId,
    };
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
