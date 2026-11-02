"use strict";

// The "remote" commands: play the CLI daemon and the agent of the WebSocket approach. Each command starts
// a stand-in daemon, waits for the Pinggy app to connect and prove itself, runs 1 scenario, and stops.
// This process does no screen work itself, so it needs no grant of its own.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { ScreenDaemon, SCREEN_PATH, PROTOCOL_VERSION } = require("./screenDaemon.cjs");
const { issueGrant, verifyProof, forgedProof } = require("./fakeDashboard.cjs");

// Screenshots go beside the app's reports. Windows keeps logs under %LOCALAPPDATA%, as the CLI's
// getPinggyLogDir() does.
const REPORT_DIRECTORY = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "pinggy-cu-poc", "Logs")
    : path.join(os.homedir(), "Library", "Logs", "pinggy-cu-poc");

// The app polls for the daemon every second.
const PROVIDER_WAIT_MILLIS = 15000;
// The app waits 60 s for the user's answer before it reports no_answer.
const CONSENT_CALL_TIMEOUT_MILLIS = 75000;
const RENEW_INTERVAL_MILLIS = 60000;
const FAKE_PROVIDER_TIMEOUT_MILLIS = 5000;
const MAX_FRAME_BYTES = 32768;
const DEFAULT_REASON = "PoC: take a screenshot and move the mouse";
const DEFAULT_CLIENT_NAME = "PoC client";
const BROWSER_ORIGIN = "https://attacker.example";

function optionValue(args, name) {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function errorCodeOf(promise) {
    return promise.then(() => "allowed", (error) => error.code || error.message);
}

function saveScreenshot(screenshot, label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotPath = path.join(REPORT_DIRECTORY, `remote-${stamp}-${label}.jpg`);
    fs.mkdirSync(REPORT_DIRECTORY, { recursive: true });
    const jpeg = Buffer.from(screenshot.jpeg_base64, "base64");
    fs.writeFileSync(screenshotPath, jpeg);
    return {
        path: screenshotPath,
        width: screenshot.width,
        height: screenshot.height,
        points_per_image_pixel: screenshot.points_per_image_pixel,
        jpeg_bytes: jpeg.length,
        frames_at_32k: Math.ceil(screenshot.jpeg_base64.length / MAX_FRAME_BYTES),
        duration_millis: screenshot.duration_millis,
    };
}

function screenCenter(screenshot) {
    return {
        x: Math.round((screenshot.width / 2) * screenshot.points_per_image_pixel),
        y: Math.round((screenshot.height / 2) * screenshot.points_per_image_pixel),
    };
}

function sessionFromArgs(args) {
    return {
        sessionId: crypto.randomUUID(),
        clientName: optionValue(args, "--client") || DEFAULT_CLIENT_NAME,
        reason: optionValue(args, "--reason") || DEFAULT_REASON,
        preApproved: args.includes("--pre-approved"),
    };
}

async function startSession(daemon, session) {
    const grant = issueGrant(daemon.provider, session);
    const startedAtMillis = Date.now();
    const answer = await daemon.call("control_start", { grant }, CONSENT_CALL_TIMEOUT_MILLIS);
    return { ...answer, session_id: session.sessionId, consent_millis: Date.now() - startedAtMillis };
}

// status, consent, 1 capture, 1 move to the screen center with the fresh capture, end.
async function runSession(daemon, args) {
    const report = { status: await daemon.call("status") };
    report.control_start = await startSession(daemon, sessionFromArgs(args));
    if (report.control_start.outcome !== "active") return report;
    const firstCapture = await daemon.call("capture");
    report.capture = saveScreenshot(firstCapture, "capture");
    if (report.control_start.input_allowed) {
        const inputAnswer = await daemon.call("input", { action: "move", ...screenCenter(firstCapture) });
        report.input = { cursor_after: inputAnswer.result, capture: saveScreenshot(inputAnswer.screenshot, "input") };
    }
    report.control_end = await daemon.call("control_end");
    return report;
}

// Starts a session, renews its grant, and waits for the app to end it: Stop, the shortcut, the TTL, or a
// missed renewal. --no-renew skips the renewals.
async function holdSession(daemon, args) {
    const session = sessionFromArgs(args);
    const report = { control_start: await startSession(daemon, session), renewals: [] };
    if (report.control_start.outcome !== "active") return report;
    const heldFromMillis = Date.now();
    const renewTimer = args.includes("--no-renew") ? null : setInterval(() => {
        const renewal = daemon.call("renew", { grant: issueGrant(daemon.provider, session) });
        renewal.then((result) => report.renewals.push(result), (error) => report.renewals.push({ error: error.code }));
    }, RENEW_INTERVAL_MILLIS);
    const ended = await new Promise((resolve) => {
        daemon.once("control_end", resolve);
        daemon.once("provider_gone", () => resolve({ reason: "app_not_running" }));
    });
    clearInterval(renewTimer);
    report.control_end = { reason: ended.reason, held_millis: Date.now() - heldFromMillis };
    report.capture_after_end = await errorCodeOf(daemon.call("capture"));
    return report;
}

function controlStartWith(daemon, grant) {
    return errorCodeOf(daemon.call("control_start", { grant }, CONSENT_CALL_TIMEOUT_MILLIS));
}

// Each of these must answer grant_invalid before any dialog shows.
async function forgedGrant(daemon, args) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    return controlStartWith(daemon, issueGrant(daemon.provider, sessionFromArgs(args), { signingKey: privateKey }));
}

async function expiredGrant(daemon, args) {
    return controlStartWith(daemon, issueGrant(daemon.provider, sessionFromArgs(args), { lifetimeSeconds: -1 }));
}

// A grant from the app's previous connection, as a daemon restart would leave behind.
async function replayedGrant(daemon, args) {
    const oldGrant = issueGrant(daemon.provider, sessionFromArgs(args));
    const providerGone = new Promise((resolve) => daemon.once("provider_gone", resolve));
    daemon.disconnectProvider();
    await providerGone;
    const reconnectedFromMillis = Date.now();
    await daemon.waitForProvider(PROVIDER_WAIT_MILLIS);
    return { reconnect_millis: Date.now() - reconnectedFromMillis, control_start: await controlStartWith(daemon, oldGrant) };
}

function fakeProviderAttempt(daemon, connectOptions, proofFor) {
    return new Promise((resolve) => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${daemon.port}${SCREEN_PATH}`, connectOptions);
        const finish = (outcome) => {
            clearTimeout(timer);
            webSocket.terminate();
            resolve(outcome);
        };
        const timer = setTimeout(() => finish({ outcome: "no_answer" }), FAKE_PROVIDER_TIMEOUT_MILLIS);
        webSocket.on("unexpected-response", (request, response) => finish({ outcome: "http", status: response.statusCode }));
        webSocket.on("error", (error) => finish({ outcome: "error", message: error.message }));
        webSocket.on("open", () => webSocket.send(JSON.stringify({ type: "provider_hello", protocol_version: PROTOCOL_VERSION })));
        webSocket.on("message", (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === "provider_welcome") return webSocket.send(JSON.stringify(proofFor(message.daemon_nonce)));
            finish({ outcome: message.type, reason: message.reason });
        });
    });
}

// A web page, then a local program with the app's key id but not its key. The real app stays the
// provider throughout.
async function fakeProvider(daemon) {
    const appKeyId = daemon.provider.appKeyId;
    const forged = (daemonNonce) => ({ type: "provider_proof", ...forgedProof(daemonNonce, appKeyId) });
    return {
        from_browser_origin: await fakeProviderAttempt(daemon, { origin: BROWSER_ORIGIN }, forged),
        with_forged_proof: await fakeProviderAttempt(daemon, {}, forged),
        real_app_still_provider: await errorCodeOf(daemon.call("status")),
    };
}

const REMOTE_COMMANDS = {
    status: (daemon) => daemon.call("status"),
    session: runSession,
    hold: holdSession,
    "capture-without-session": (daemon) => errorCodeOf(daemon.call("capture")),
    "forged-grant": forgedGrant,
    "expired-grant": expiredGrant,
    "replayed-grant": replayedGrant,
    "fake-provider": fakeProvider,
};

function describeProvider(provider) {
    const { identity, daemon_check: daemonCheck } = provider.hello;
    return { app_key_id: provider.appKeyId, identity, daemon_check: daemonCheck };
}

async function runRemoteCommand(args) {
    const [subcommand, ...subcommandArgs] = args;
    const command = REMOTE_COMMANDS[subcommand];
    if (!command) return null;
    const daemon = new ScreenDaemon(verifyProof);
    const rejected = [];
    daemon.on("rejected", (rejection) => rejected.push(rejection));
    try {
        const daemonInfo = await daemon.start();
        const provider = await daemon.waitForProvider(PROVIDER_WAIT_MILLIS);
        const result = await command(daemon, subcommandArgs);
        return { daemon: daemonInfo, provider: describeProvider(provider), [subcommand]: result, rejected };
    } catch (error) {
        return { error: error.code || "failed", message: error.message, rejected };
    } finally {
        daemon.stop();
    }
}

module.exports = { runRemoteCommand };
