import { PinggyOptions } from "@pinggy/pinggy";

// Local representation of additional forwarding
export interface AdditionalForwarding {
    remoteDomain?: string;
    remotePort: number;
    localDomain: string;
    localPort: number;
}

export interface TunnelStatus {
    tunnelid: string,
    remoteurls: string[],
    tunnelconfig: PinggyOptions,
    status: Status,
    stats: Stats
}

export interface Stats {
    numLiveConnections: number;
    numTotalConnections: number;
    numTotalReqBytes: number;
    numTotalResBytes: number;
    numTotalTxBytes: number;
}

// Enum for TunnelStateType
export enum TunnelStateType {
    New = "idle",
    Starting = "starting",
    Running = "running",
    Live = "live",
    Closed = "closed",
    Exited = "exited"
}

// Enum for TunnelErrorCodeType
export enum TunnelErrorCodeType {
    NonResponsive = "non_responsive",
    FailedToConnect = "failed_to_connect",
    ErrorInAdditionalForwarding = "additional_forwarding_error",
    WebdebuggerError = "webdebugger_error",
    NoError = ""
}

// Enum for TunnelWarningCode
export enum TunnelWarningCode {
    InvalidTunnelServePath = "INVALID_TUNNEL_SERVE_PATH"
}

// Interface for Warning
export interface Warning {
    code: TunnelWarningCode;
    message: string;
}



// Main Status interface
export interface Status {
    state: TunnelStateType;
    errorcode: TunnelErrorCodeType;
    errormsg: string;
    createdtimestamp: Date;
    starttimestamp: Date;
    endtimestamp: Date;
    warnings: Warning[];
}

export type Forwarding = {
    remoteDomain?: string;
    remotePort: number;
    localDomain: string;
    localPort: number;
};

export type FinalConfig = (PinggyOptions & { configid: string }) & {
    conf?: string;
    serve?: string;
    remoteManagement?: string;
    additionalForwarding?: Forwarding[];
    manage?: string;
    version?: boolean;
};

export type ErrorCodeType =
    | "INVALID_REQUEST_METHOD"
    | "COULD_NOT_READ_BODY"
    | "INTERNAL_SERVER_ERROR"
    | "INVALID_DATA_FORMAT"
    | "ERROR_STARTING_TUNNEL"
    | "TUNNEL_WITH_ID_OR_CONFIG_ID_NOT_FOUND"
    | "TUNNEL_WITH_ID_OR_CONFIG_ID_ALREADY_RUNNING"
    | "WEBSOCKET_UPGRADE_FAILED"
    | "REMOTE_MANAGEMENT_ALREADY_RUNNING"
    | "REMOTE_MANAGEMENT_NOT_RUNNING"
    | "REMOTE_MANAGEMENT_DESERIALIZATION_FAILED";

export const ErrorCode: Record<string, ErrorCodeType> = {
    InvalidRequestMethodError: "INVALID_REQUEST_METHOD",
    InvalidRequestBodyError: "COULD_NOT_READ_BODY",
    InternalServerError: "INTERNAL_SERVER_ERROR",
    InvalidBodyFormatError: "INVALID_DATA_FORMAT",
    ErrorStartingTunnel: "ERROR_STARTING_TUNNEL",
    TunnelNotFound: "TUNNEL_WITH_ID_OR_CONFIG_ID_NOT_FOUND",
    TunnelAlreadyRunningError: "TUNNEL_WITH_ID_OR_CONFIG_ID_ALREADY_RUNNING",
    WebsocketUpgradeFailError: "WEBSOCKET_UPGRADE_FAILED",
    RemoteManagementAlreadyRunning: "REMOTE_MANAGEMENT_ALREADY_RUNNING",
    RemoteManagementNotRunning: "REMOTE_MANAGEMENT_NOT_RUNNING",
    RemoteManagementDeserializationFailed: "REMOTE_MANAGEMENT_DESERIALIZATION_FAILED",
} as const;

export interface ErrorResponse {
    code: ErrorCodeType;
    message: string;
}

export function isErrorResponse(obj: unknown): obj is ErrorResponse {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        'code' in obj &&
        'message' in obj &&
        typeof (obj as ErrorResponse).message === 'string' &&
        Object.values(ErrorCode).includes((obj as ErrorResponse).code)
    );
}

export function newErrorResponse(errorResponse: ErrorResponse): ErrorResponse;
export function newErrorResponse(code: ErrorCodeType, message: string): ErrorResponse;
export function newErrorResponse(codeOrError: ErrorCodeType | ErrorResponse, message?: string): ErrorResponse {
    if (typeof codeOrError === 'object') {
        return codeOrError;
    }
    return {
        code: codeOrError,
        message: message!
    };
}


export interface ResponseObj {
    response: Uint8Array;
    requestid: string;
    command: string;
    error: boolean;
    errorresponse: ErrorResponse;
}

export function NewResponseObject(data: unknown): ResponseObj {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(JSON.stringify(data));
    return {
        response: bytes,
        requestid: "",
        command: "",
        error: false,
        errorresponse: {} as ErrorResponse,
    };
}

export function NewErrorResponseObject(errorResponse: ErrorResponse): ResponseObj {
    return {
        response: new Uint8Array(),
        requestid: "",
        command: "",
        error: true,
        errorresponse: errorResponse,
    };
}

export function newStatus(
    tunnelState: TunnelStateType,
    errorCode: TunnelErrorCodeType,
    errorMsg: string,
    startTimestamp: Date,
    endTimestamp: Date
): Status {
    let assignedState = tunnelState;
    if (tunnelState === TunnelStateType.Live) {
        assignedState = TunnelStateType.Running;
    } else if (tunnelState === TunnelStateType.New) {
        assignedState = TunnelStateType.Starting;
    } else if (tunnelState === TunnelStateType.Closed) {
        assignedState = TunnelStateType.Exited;
    }

    return {
        state: assignedState,
        errorcode: errorCode,
        errormsg: errorMsg,
        createdtimestamp: new Date(),
        starttimestamp: startTimestamp,
        endtimestamp: endTimestamp,
        warnings: []
    };
}

export function newStats(): Stats {
    return {
        numLiveConnections: 0,
        numTotalConnections: 0,
        numTotalReqBytes: 0,
        numTotalResBytes: 0,
        numTotalTxBytes: 0
    };
}
