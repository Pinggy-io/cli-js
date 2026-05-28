export const FileServerMessage = {
    Started: "started",
    Warning: "warning",
    Error:   "error",
} as const;
export type FileServerMessageType = typeof FileServerMessage[keyof typeof FileServerMessage];

export type FileServerWorkerMessage =
    | { type: typeof FileServerMessage.Started; portNum?: number }
    | { type: typeof FileServerMessage.Warning; message: string; code?: string }
    | { type: typeof FileServerMessage.Error;   error: string;   code?: string };
