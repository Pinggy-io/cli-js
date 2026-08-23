import WebSocket from "ws";
import { logger } from "../logger.js";
import { ErrorCode, ErrorCodeType, NewErrorResponseObject, ResponseObj, ErrorResponse, isErrorResponse, NewResponseObject, newErrorResponse } from "../types.js";
import { TunnelHandler, TunnelOperations, TunnelResponse, TunnelResponseV2 } from "./handler.js";
import { GetSchema, RestartSchema, StartSchema, StartV2Schema, StopSchema, UpdateConfigSchema, UpdateConfigV2Schema } from "./remote_schema.js";
import { remoteManagementWebSocketPrinter } from "./websocket_printer.js";
import z from "zod";
import CLIPrinter from "../utils/printer.js";
import { errorMessage, getVersion } from "../utils/util.js";

export interface ConnectionStatus {
  success: boolean;
  error_code?: number;
  error_msg?: string;
}

export interface WebSocketRequest {
  requestid: string;
  command: string;
  data?: string;
}

export const WsCommand = {
  Start:          "start",
  StartV2:        "start-v2",
  Stop:           "stop",
  Get:            "get",
  Restart:        "restart",
  UpdateConfig:   "updateconfig",
  UpdateConfigV2: "update-config-v2",
  List:           "list",
  ListV2:         "list-v2",
  GetVersion:     "get-version",
} as const;
export type WsCommand = typeof WsCommand[keyof typeof WsCommand];

export class WebSocketCommandHandler {
  private tunnelHandler: TunnelHandler;
    constructor(handler?: TunnelHandler) {
    this.tunnelHandler = handler ?? new TunnelOperations();
  }

  private safeParse(text?: string): unknown {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch (e) {
      logger.warn("Invalid JSON payload", { error: String(e), text });
      return undefined;
    }
  }

  private sendResponse(ws: WebSocket, resp: ResponseObj) {
    const payload = {
      ...resp,
      response: Buffer.from(resp.response || []).toString("base64"),
    };
    ws.send(JSON.stringify(payload));
  }

  private sendError(ws: WebSocket, req: Partial<WebSocketRequest>, message: string, code: ErrorCodeType = ErrorCode.InternalServerError) {
    const resp = NewErrorResponseObject({ code, message });
    resp.command = req.command || "";
    resp.requestid = req.requestid || "";
    this.sendResponse(ws, resp);
  }

  private async handleStartReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    let queuedConfig;
    try {
      const dc = StartSchema.parse(raw);
      queuedConfig = dc.tunnelConfig;
      remoteManagementWebSocketPrinter.queueStart(dc.tunnelConfig);
      const result = await this.tunnelHandler.handleStart(dc.tunnelConfig, true);
      remoteManagementWebSocketPrinter.handleStartResult(dc.tunnelConfig, result);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (queuedConfig) {
        remoteManagementWebSocketPrinter.failQueuedStart(queuedConfig, String(e));
      }
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for start request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      CLIPrinter.warn(`Error in handleStartReq error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleStartV2Req(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    let queuedConfig;
    try {
      const dc = StartV2Schema.parse(raw);
      queuedConfig = dc.tunnelConfig;
      remoteManagementWebSocketPrinter.queueStart(dc.tunnelConfig);
      const result = await this.tunnelHandler.handleStartV2(dc.tunnelConfig, true);
      remoteManagementWebSocketPrinter.handleStartResult(dc.tunnelConfig, result);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (queuedConfig) {
        remoteManagementWebSocketPrinter.failQueuedStart(queuedConfig, String(e));
      }
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for start-v2 request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      CLIPrinter.warn(`Error in handleStartV2Req error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleStopReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    let tunnelID;
    try {
      const dc = StopSchema.parse(raw);
      tunnelID = dc.tunnelID;
      remoteManagementWebSocketPrinter.printStopRequested(dc.tunnelID);
      const result = await this.tunnelHandler.handleStop(dc.tunnelID);
      remoteManagementWebSocketPrinter.handleStopResult(dc.tunnelID, result);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for stop request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      if (tunnelID) {
        remoteManagementWebSocketPrinter.handleStopResult(tunnelID, newErrorResponse({ code: ErrorCode.InternalServerError, message: errorMessage(e) }));
      }
      CLIPrinter.warn(`Error in handleStopReq error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleGetReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    try {
      const dc = GetSchema.parse(raw);
      const result = await this.tunnelHandler.handleGet(dc.tunnelID);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for get request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      CLIPrinter.warn(`Error in handleGetReq error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleRestartReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    let tunnelID;
    try {
      const dc = RestartSchema.parse(raw);
      tunnelID = dc.tunnelID;
      remoteManagementWebSocketPrinter.printRestartRequested(dc.tunnelID);
      const result = await this.tunnelHandler.handleRestart(dc.tunnelID, true);
      remoteManagementWebSocketPrinter.handleRestartResult(dc.tunnelID, result);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for restart request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      if (tunnelID) {
        remoteManagementWebSocketPrinter.handleRestartResult(tunnelID, newErrorResponse({ code: ErrorCode.InternalServerError, message: errorMessage(e) }));
      }
      CLIPrinter.warn(`Error in handleRestartReq error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleUpdateConfigReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    let parsedConfig;
    try {
      const dc = UpdateConfigSchema.parse(raw);
      parsedConfig = dc.tunnelConfig;
      remoteManagementWebSocketPrinter.printUpdateConfigRequested(dc.tunnelConfig);
      const result = await this.tunnelHandler.handleUpdateConfig(dc.tunnelConfig, true);
      remoteManagementWebSocketPrinter.handleUpdateConfigResult(dc.tunnelConfig, result);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for updateconfig request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      if (parsedConfig) {
        remoteManagementWebSocketPrinter.handleUpdateConfigResult(parsedConfig, newErrorResponse({ code: ErrorCode.InternalServerError, message: errorMessage(e) }));
      }
      CLIPrinter.warn(`Error in handleUpdateConfigReq error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleUpdateConfigV2Req(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    let parsedConfig;
    try {
      const dc = UpdateConfigV2Schema.parse(raw);
      parsedConfig = dc.tunnelConfig;
      remoteManagementWebSocketPrinter.printUpdateConfigRequested(dc.tunnelConfig);
      const result = await this.tunnelHandler.handleUpdateConfigV2(dc.tunnelConfig, true);
      remoteManagementWebSocketPrinter.handleUpdateConfigResult(dc.tunnelConfig, result);
      return this.wrapResponse(result, req);
    } catch (e) {
      if (e instanceof z.ZodError) {
        CLIPrinter.warn("Validation failed for update-config-v2 request");
        return NewErrorResponseObject({ code: ErrorCode.InvalidBodyFormatError, message: "Validation failed" });
      }
      if (parsedConfig) {
        remoteManagementWebSocketPrinter.handleUpdateConfigResult(parsedConfig, newErrorResponse({ code: ErrorCode.InternalServerError, message: errorMessage(e) }));
      }
      CLIPrinter.warn(`Error in handleUpdateConfigV2Req error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleListReq(req: WebSocketRequest): Promise<ResponseObj> {
    try {
      const result = await this.tunnelHandler.handleList();
      remoteManagementWebSocketPrinter.monitorList(result);
      return this.wrapResponse(result, req);
    } catch (e) {
      CLIPrinter.warn(`Error in handleListReq error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private async handleListV2Req(req: WebSocketRequest): Promise<ResponseObj> {
    try {
      const result = await this.tunnelHandler.handleListV2();
      remoteManagementWebSocketPrinter.monitorList(result);
      return this.wrapResponse(result, req);
    } catch (e) {
      CLIPrinter.warn(`Error in handleListV2Req error: ${String(e)}`);
      return NewErrorResponseObject({ code: ErrorCode.InternalServerError, message: String(e) });
    }
  }

  private handleGetVersionReq(ws: WebSocket, req: WebSocketRequest): void {
    try {
      const versionResponse = {
        cli_version: getVersion(),
      };
      const payload = {
        command: req.command,
        requestid: req.requestid,
        response: JSON.stringify(versionResponse),
        error: false,
      };
      ws.send(JSON.stringify(payload));
    } catch (e) {
      CLIPrinter.warn(`Error in handleGetVersionReq error: ${String(e)}`);
      this.sendError(ws, req, String(e));
    }
  }

  private wrapResponse(result: ResponseObj | ErrorResponse | TunnelResponse | TunnelResponseV2 | TunnelResponse[] | TunnelResponseV2[], req: WebSocketRequest): ResponseObj {
    if (isErrorResponse(result)) {
      const errResp = NewErrorResponseObject(result);
      errResp.command = req.command;
      errResp.requestid = req.requestid;
      return errResp;
    }

    // Temporary workaround to remove allowPreflight from response
    const finalResult = JSON.parse(JSON.stringify(result));
    if (Array.isArray(finalResult)) {
      finalResult.forEach(item => {
        if (item?.tunnelconfig) {
          delete item.tunnelconfig.allowPreflight;
        }
      });
    } else if (finalResult?.tunnelconfig) {
      delete finalResult.tunnelconfig.allowPreflight;
    }
    const respObj = NewResponseObject(finalResult);
    respObj.command = req.command;
    respObj.requestid = req.requestid;
    return respObj;
  }

  async handle(ws: WebSocket, req: WebSocketRequest) {
    const cmd = (req.command || "").toLowerCase() as WsCommand | string;
    const raw = this.safeParse(req.data);
    try {
      let response: ResponseObj;
      switch (cmd as WsCommand) {
        case WsCommand.Start: {
          response = await this.handleStartReq(req, raw);
          break;
        }
        case WsCommand.StartV2: {
          response = await this.handleStartV2Req(req, raw);
          break;
        }
        case WsCommand.Stop: {
          response = await this.handleStopReq(req, raw);
          break;
        }
        case WsCommand.Get: {
          response = await this.handleGetReq(req, raw);
          break;
        }
        case WsCommand.Restart: {
          response = await this.handleRestartReq(req, raw);
          break;
        }
        case WsCommand.UpdateConfig: {
          response = await this.handleUpdateConfigReq(req, raw);
          break;
        }
        case WsCommand.UpdateConfigV2: {
          response = await this.handleUpdateConfigV2Req(req, raw);
          break;
        }
        case WsCommand.List: {
          response = await this.handleListReq(req);
          break;
        }
        case WsCommand.ListV2: {
          response = await this.handleListV2Req(req);
          break;
        }
        case WsCommand.GetVersion: {
          this.handleGetVersionReq(ws, req);
          return;
        }
        default:
          if (typeof req.command === 'string') {
            logger.warn("Unknown command", { command: req.command });
          }
          return this.sendError(ws, req, "Invalid command");
      }
      logger.debug("Sending response", { command: response.command, requestid: response.requestid });
      this.sendResponse(ws, response);
    } catch (e) {
      if (e instanceof z.ZodError) {
        logger.warn("Validation failed", { cmd, issues: e.issues });
        return this.sendError(ws, req, "Invalid request data", ErrorCode.InvalidBodyFormatError);
      }
      logger.error("Error handling command", { cmd, error: errorMessage(e) });
      return this.sendError(ws, req, errorMessage(e) || "Internal error");
    }
  }
}

export function sendVersionResponse(ws: WebSocket) {
  const versionResponse = {
    cli_version: getVersion(),
  };

  const payload = {
    command: WsCommand.GetVersion,
    requestid: "0",
    response: JSON.stringify(versionResponse),
    error: false,
  };
  ws.send(JSON.stringify(payload));
}

// Returns true if connection status is OK else sends logs and returns false
export function handleConnectionStatusMessage(firstMessage: WebSocket.Data): boolean {
  try {
    const text = typeof firstMessage === 'string' ? firstMessage : firstMessage.toString();
    const cs = JSON.parse(text) as ConnectionStatus;
    if (!cs.success) {
      const msg = cs.error_msg || "Connection failed";
      CLIPrinter.warn(`Connection failed: ${msg}`);
      logger.warn("Remote management connection failed", { error_code: cs.error_code, error_msg: msg });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn("Failed to parse connection status message", { error: String(e) });
    // If parsing fails, assume connection is okay
    return true;
  }
}
