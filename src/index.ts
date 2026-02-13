#!/usr/bin/env node

import {
  checkVCRedist,
  openDownloadPage,
} from "./utils/detect_vc_redist_on_windows.js";
import CLIPrinter from "./utils/printer.js";

// Public API re-exports
export { TunnelManager } from "./tunnel_manager/TunnelManager.js";
export { TunnelOperations, TunnelResponse } from "./remote_management/handler.js";
export { enablePackageLogging } from "./logger.js";
export {
  getRemoteManagementState,
  initiateRemoteManagement,
  closeRemoteManagement,
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
  CLIPrinter.error(`Failed to start CLI:, ${err}`);
  process.exit(1);
});
