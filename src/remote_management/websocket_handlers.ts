import WebSocket from "ws";
import { logger } from "../logger.js";
import { ErrorCode, NewErrorResponseObject, ResponseObj, ErrorResponse, isErrorResponse, NewResponseObject } from "../types.js";
import { TunnelOperations, TunnelResponse } from "./handler.js";
import { GetSchema, RestartSchema, StartSchema, StopSchema, UpdateConfigSchema } from "./remote_schema.js";
import z from "zod";
import CLIPrinter from "../utils/printer.js";

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

type CommandName = "start" | "stop" | "get" | "restart" | "updateconfig" | "list";

export class WebSocketCommandHandler {
  private tunnelHandler = new TunnelOperations();

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

  private sendError(ws: WebSocket, req: Partial<WebSocketRequest>, message: string, code = ErrorCode.InternalServerError) {
    const resp = NewErrorResponseObject({ code, message });
    resp.command = req.command || "";
    resp.requestid = req.requestid || "";
    this.sendResponse(ws, resp);
  }

  private async handleStartReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    const dc = StartSchema.parse(raw);
    const result = await this.tunnelHandler.handleStart(dc.tunnelConfig);
    return this.wrapResponse(result, req);
  }

  private async handleStopReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    const dc = StopSchema.parse(raw);
    const result = await this.tunnelHandler.handleStop(dc.tunnelID);
    return this.wrapResponse(result, req);
  }

  private async handleGetReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    const dc = GetSchema.parse(raw);
    const result = await this.tunnelHandler.handleGet(dc.tunnelID);
    return this.wrapResponse(result, req);
  }

  private async handleRestartReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    const dc = RestartSchema.parse(raw);
    const result = await this.tunnelHandler.handleRestart(dc.tunnelID);
    return this.wrapResponse(result, req);
  }

  private async handleUpdateConfigReq(req: WebSocketRequest, raw: unknown): Promise<ResponseObj> {
    const dc = UpdateConfigSchema.parse(raw);
    const result = await this.tunnelHandler.handleUpdateConfig(dc.tunnelConfig);
    return this.wrapResponse(result, req);
  }

  private async handleListReq(req: WebSocketRequest): Promise<ResponseObj> {
    const result = await this.tunnelHandler.handleList();
    return this.wrapResponse(result, req);
  }

  private wrapResponse(result: ResponseObj | ErrorResponse | TunnelResponse | TunnelResponse[], req: WebSocketRequest): ResponseObj {
    if (isErrorResponse(result)) {
      const errResp = NewErrorResponseObject(result);
      errResp.command = req.command;
      errResp.requestid = req.requestid;
      return errResp;
    }
    const respObj = NewResponseObject(result);
    respObj.command = req.command;
    respObj.requestid = req.requestid;
    return respObj;
  }

  async handle(ws: WebSocket, req: WebSocketRequest) {
    const cmd = (req.command || "").toLowerCase() as CommandName | string;
    const raw = this.safeParse(req.data);

    try {
      let response: ResponseObj;
      switch (cmd as CommandName) {
        case "start": {
          response = await this.handleStartReq(req, raw);
          break;
        }
        case "stop": {
          response = await this.handleStopReq(req, raw);
          break;
        }
        case "get": {
          response = await this.handleGetReq(req, raw);
          break;
        }
        case "restart": {
          response = await this.handleRestartReq(req, raw);
          break;
        }
        case "updateconfig": {
          response = await this.handleUpdateConfigReq(req, raw);
          break;
        }
        case "list": {
          response = await this.handleListReq(req);
          break;
        }
        default:
          if (typeof req.command === 'string') {
            logger.warn("Unknown command", { command: req.command });
          }
          return this.sendError(ws, req, "Invalid command");
      }
      logger.debug("Sending response", { command: response.command, requestid: response.requestid });
      this.sendResponse(ws, response);
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        logger.warn("Validation failed", { cmd, issues: e.issues });
        return this.sendError(ws, req, "Invalid request data", ErrorCode.InvalidBodyFormatError);
      }
      logger.error("Error handling command", { cmd, error: String(e) });
      return this.sendError(ws, req, e?.message || "Internal error");
    }
  }
}

// // Returns true if connection status is OK else sends logs and returns false
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
