import WebSocket from "ws";
import { logger } from "../logger";
import { ErrorCode, NewErrorResponseObject, ResponseObj, ErrorResponse, isErrorResponse, NewResponseObject } from "../types";
import { TunnelOperations, TunnelResponse } from "../tunnel_manager/handler";
import { GetSchema, RestartSchema, StartSchema, StopSchema, UpdateConfigSchema } from "../tunnel_manager/remote_schema";
import z from "zod";

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


  private handleStartReq(req: WebSocketRequest, raw: unknown): ResponseObj {
    console.log("Handle Start Request :", req.requestid);
    const dc = StartSchema.parse(raw);
    const result = this.tunnelHandler.handleStart(dc.tunnelConfig);
    console.log("Start result", result);
    return this.wrapResponse(result, req);
  }

  private handleStopReq(req: WebSocketRequest, raw: unknown): ResponseObj {
    const dc = StopSchema.parse(raw);
    const result = this.tunnelHandler.handleStop(dc.tunnelID);
    return this.wrapResponse(result, req);
  }

  private handleGetReq(req: WebSocketRequest, raw: unknown): ResponseObj {
    const dc = GetSchema.parse(raw);
    const result = this.tunnelHandler.handleGet(dc.tunnelID);
    return this.wrapResponse(result, req);
  }

  private handleRestartReq(req: WebSocketRequest, raw: unknown): ResponseObj {
    const dc = RestartSchema.parse(raw);
    const result = this.tunnelHandler.handleRestart(dc.tunnelID);
    return this.wrapResponse(result, req);
  }

  private handleUpdateConfigReq(req: WebSocketRequest, raw: unknown): ResponseObj {
    const dc = UpdateConfigSchema.parse(raw);
    const result = this.tunnelHandler.handleUpdateConfig(dc.tunnelConfig);
    return this.wrapResponse(result, req);
  }

  private handleListReq(req: WebSocketRequest): ResponseObj {
    const result = this.tunnelHandler.handleList();
    return this.wrapResponse(result, req);
  }

  private wrapResponse(result: ResponseObj | ErrorResponse | TunnelResponse | TunnelResponse[], req: WebSocketRequest): ResponseObj {
    if (isErrorResponse(result)) {
      console.log("Error Response:", result);
      const errResp = NewErrorResponseObject(result);
      errResp.command = req.command;
      errResp.requestid = req.requestid;
      return errResp;
    }
    const respObj = NewResponseObject(result);
    respObj.command = req.command;
    respObj.requestid = req.requestid;
    console.log("Response Object:", respObj);
    return respObj;
  }

  async handle(ws: WebSocket, req: WebSocketRequest) {
    console.log("request received", req);
    const cmd = (req.command || "").toLowerCase();

    const raw = this.safeParse(req.data);

    try {
      let response: ResponseObj;
      switch (cmd) {
        case "start": {
          response = this.handleStartReq(req, raw);
          break;
        }
        case "stop": {
          response = this.handleStopReq(req, raw);
          break;
        }
        case "get": {
          response = this.handleGetReq(req, raw);
          break;
        }
        case "restart": {
          response = this.handleRestartReq(req, raw);
          break;
        }
        case "updateconfig": {
          response = this.handleUpdateConfigReq(req, raw);
          break;
        }
        case "list": {
          response = this.handleListReq(req);
          break;
        }
        default:
          return this.sendError(ws, req, "Invalid command");
      }
      console.log("Sending response", response);
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
      console.log("Connection failed:", msg);
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

