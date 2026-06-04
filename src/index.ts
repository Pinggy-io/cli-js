#!/usr/bin/env node

import {
  checkVCRedist,
  openDownloadPage,
} from "./utils/detect_vc_redist_on_windows.js";
import CLIPrinter from "./utils/printer.js";

// Public API re-exports
export { TunnelManager } from "./tunnel_manager/TunnelManager.js";
export { TunnelOperations, TunnelResponse } from "./remote_management/handler.js";
export { TunnelClient } from "./daemon/tunnelClient.js";
export { enablePackageLogging } from "./logger.js";
export {
  getRemoteManagementState,
  initiateRemoteManagement,
  startRemoteManagement,
  closeRemoteManagement,
  RemoteManagementUnauthorizedError,
} from "./remote_management/remoteManagement.js";

export type {
  ManagedTunnel,
  TunnelList,
  StatsListener,
  ErrorListener,
  DisconnectListener,
  TunnelWorkerErrorListner,
  StartListener,
  WillReconnectListener,
  ReconnectingListener,
  ReconnectionCompletedListener,
  ReconnectionFailedListener,
  ITunnelManager,
} from "./tunnel_manager/TunnelManager.js";

export type {
  AdditionalForwarding,
  TunnelStatus,
  Status,
  Warning,
  FinalConfig,
} from "./types.js";

export {
  TunnelStateType,
  TunnelErrorCodeType,
  TunnelWarningCode,
} from "./types.js";

export {
  saveConfig,
  upsertConfig,
  bulkReplace,
  loadConfigByName,
  findConfig,
  findConfigByName,
  deleteConfig,
  listSavedConfigs,
  updateConfigAutoStart,
  updateTunnelConfig,
  getAutoStartConfigs,
  sanitizeName,
  validateName,
  validateNameStrict,
  validateNameForStorage,
  configureStorageLogger,
} from "./cli/configStore.js";
export {
  getPinggyConfigDir,
  getTunnelConfigDir,
  ensureTunnelConfigDir,
  getDaemonInfoPath,
} from "./utils/configDir.js";
export type { SavedTunnelConfig, StorageLogger } from "./cli/configStore.js";
export type { TunnelConfigurationV1 } from "@pinggy/pinggy";
export {
  TunnelConfigV1Schema,
  TUNNEL_CONFIG_V1_KEYS,
} from "./remote_management/remote_schema.js";
export type { TunnelConfigV1 } from "./remote_management/remote_schema.js";

async function verifyAndLoad() {
  if (process.platform === "win32") {
    const vcRedist = checkVCRedist();
    if ( !vcRedist.installed ) {
      CLIPrinter.warn(
        vcRedist.message ??
          "This application requires the Microsoft Visual C++ Runtime on Windows.",
      );

      // open browser
      await openDownloadPage();

      process.exit(1);
    }
  }

  await import("./main.js");
}

verifyAndLoad().catch((err) => {
  CLIPrinter.fatal(`Failed to start CLI:, ${err}`);
});
