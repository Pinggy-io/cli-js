"use strict";

// The daemon's side of the WebSocket approach in pinggy_backend
// docs/pinggy-devices/computer-use-agent-host.md. A stand-in for the CLI daemon's IPC server: it serves
// /ws/screen on 127.0.0.1, accepts 1 proven Pinggy app as the screen provider, and sends it requests.
// It writes its own DAEMON_INFO_PATH, so the user's real CLI daemon is never touched.

const crypto = require("crypto");
const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");

// Windows keeps it under %APPDATA%, as the CLI's getPinggyConfigDir() does. The app's pocPaths.js matches.
const POC_DIRECTORY = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "pinggy-cu-poc")
    : path.join(os.homedir(), ".config", "pinggy-cu-poc");
const DAEMON_INFO_PATH = path.join(POC_DIRECTORY, "daemon.json");
const SCREEN_PATH = "/ws/screen";
const PROTOCOL_VERSION = 1;
const NONCE_BYTES = 32;
const CALL_TIMEOUT_MILLIS = 15000;
const HANDSHAKE_TIMEOUT_MILLIS = 5000;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const CLOSE_POLICY_VIOLATION = 1008;
const APP_NOT_RUNNING = "app_not_running";

function daemonError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function send(socket, message) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function refuseUpgrade(socket, statusCode) {
    socket.end(`HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\nConnection: close\r\n\r\n`);
}

// Emits "provider" when a proven app takes the slot, "provider_gone" when it leaves, "control_end" when
// the app ends the session, and "rejected" with the reason for each refused connection.
class ScreenDaemon extends EventEmitter {
    // verifyProof(proof, daemonNonce) returns the app's identity or throws: the dashboard's key check.
    constructor(verifyProof) {
        super();
        this.verifyProof = verifyProof;
        this.provider = null;
        this.nextCallId = 1;
        this.httpServer = http.createServer((request, response) => {
            response.writeHead(HTTP_NOT_FOUND).end();
        });
        this.webSocketServer = new WebSocketServer({ noServer: true });
        this.httpServer.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    }

    start() {
        return new Promise((resolve) => {
            this.httpServer.listen(0, "127.0.0.1", () => {
                const daemonInfo = { pid: process.pid, port: this.httpServer.address().port };
                fs.mkdirSync(POC_DIRECTORY, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
                fs.writeFileSync(DAEMON_INFO_PATH, JSON.stringify(daemonInfo) + "\n", { mode: OWNER_ONLY_FILE_MODE });
                resolve(daemonInfo);
            });
        });
    }

    stop() {
        fs.rmSync(DAEMON_INFO_PATH, { force: true });
        for (const client of this.webSocketServer.clients) client.terminate();
        this.httpServer.close();
    }

    get port() {
        return this.httpServer.address().port;
    }

    // Browsers always send Origin, and CORS does not stop a page from opening ws://127.0.0.1. Node
    // clients send none.
    upgrade(request, socket, head) {
        if (request.headers.origin !== undefined) {
            this.emit("rejected", { reason: "origin", origin: request.headers.origin });
            return refuseUpgrade(socket, HTTP_FORBIDDEN);
        }
        if (request.url !== SCREEN_PATH) return refuseUpgrade(socket, HTTP_NOT_FOUND);
        this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => this.handshake(webSocket));
    }

    handshake(webSocket) {
        const daemonNonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
        const deadline = setTimeout(() => this.refuse(webSocket, "handshake_timeout"), HANDSHAKE_TIMEOUT_MILLIS);
        let hello = null;
        webSocket.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return this.refuse(webSocket, "unexpected_message");
            }
            if (this.provider && this.provider.webSocket === webSocket) return this.settle(message);
            if (message.type === "provider_hello") {
                if (message.protocol_version !== PROTOCOL_VERSION) return this.refuse(webSocket, "protocol_mismatch");
                hello = message;
                return send(webSocket, { type: "provider_welcome", daemon_nonce: daemonNonce });
            }
            if (message.type === "provider_proof" && hello) {
                clearTimeout(deadline);
                return this.accept(webSocket, hello, message, daemonNonce);
            }
            this.refuse(webSocket, "unexpected_message");
        });
        webSocket.on("close", () => {
            clearTimeout(deadline);
            if (this.provider && this.provider.webSocket === webSocket) this.dropProvider();
        });
    }

    // The proof is checked before the slot, so a program with the wrong key never learns whether the app
    // is connected.
    accept(webSocket, hello, proof, daemonNonce) {
        let appIdentity;
        try {
            appIdentity = this.verifyProof(proof, daemonNonce);
        } catch (error) {
            return this.refuse(webSocket, error.code || "proof_invalid");
        }
        if (this.provider) return this.refuse(webSocket, "provider_exists");
        this.provider = {
            webSocket,
            hello,
            appKeyId: appIdentity.app_key_id,
            daemonNonce,
            proof,
            pendingCalls: new Map(),
        };
        send(webSocket, { type: "provider_accepted" });
        this.emit("provider", this.provider);
    }

    refuse(webSocket, reason) {
        this.emit("rejected", { reason });
        send(webSocket, { type: "provider_rejected", reason });
        webSocket.close(CLOSE_POLICY_VIOLATION, reason);
    }

    dropProvider() {
        const { pendingCalls } = this.provider;
        this.provider = null;
        for (const pendingCall of pendingCalls.values()) {
            clearTimeout(pendingCall.timer);
            pendingCall.reject(daemonError(APP_NOT_RUNNING, "the app closed the connection"));
        }
        this.emit("provider_gone");
    }

    waitForProvider(timeoutMillis) {
        if (this.provider) return Promise.resolve(this.provider);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener("provider", onProvider);
                reject(daemonError(APP_NOT_RUNNING, `no app connected within ${timeoutMillis} ms`));
            }, timeoutMillis);
            const onProvider = (provider) => {
                clearTimeout(timer);
                resolve(provider);
            };
            this.once("provider", onProvider);
        });
    }

    call(operation, args = {}, timeoutMillis = CALL_TIMEOUT_MILLIS) {
        const provider = this.provider;
        if (!provider) return Promise.reject(daemonError(APP_NOT_RUNNING, "no app is connected"));
        const callId = this.nextCallId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                provider.pendingCalls.delete(callId);
                reject(daemonError("timeout", `${operation} timed out after ${timeoutMillis} ms`));
            }, timeoutMillis);
            provider.pendingCalls.set(callId, { resolve, reject, timer });
            send(provider.webSocket, { type: "screen_request", id: callId, op: operation, args });
        });
    }

    settle(message) {
        if (message.type === "screen_event") return this.emit(message.event, message);
        if (message.type !== "screen_response") return;
        const pendingCall = this.provider.pendingCalls.get(message.id);
        if (!pendingCall) return;
        this.provider.pendingCalls.delete(message.id);
        clearTimeout(pendingCall.timer);
        if (message.ok) pendingCall.resolve(message.result);
        else pendingCall.reject(daemonError(message.error, message.message));
    }

    // Closes the provider's connection, as a daemon restart would. The app reconnects on its own.
    disconnectProvider() {
        if (this.provider) this.provider.webSocket.close();
    }
}

module.exports = { ScreenDaemon, DAEMON_INFO_PATH, POC_DIRECTORY, SCREEN_PATH, PROTOCOL_VERSION };
