"use strict";

// Runs 1 command and watches for a Keychain dialog while it runs.
//
//   node scripts/probe.cjs <label> [--wait] -- <command> [args...]
//
// It finds the dialog with out/dialogWindows, which it compiles from scripts/dialogWindows.swift on first
// use.
//
// outcome:
//   completed  the command finished and no dialog showed
//   prompted   a new SecurityAgent window showed. The probe kills the command's process group and
//              reports whether the dialog closed with it. A dialog outlives its requester, so the probe
//              then stops SecurityAgent, which closes it. macOS starts SecurityAgent again at the next
//              request. With --wait, the probe waits for the person to answer instead.
//   hung       the command neither finished nor showed a dialog in time

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const POLL_INTERVAL_MILLIS = 250;
const COMMAND_TIMEOUT_MILLIS = 20000;
const ANSWER_TIMEOUT_MILLIS = 120000;
const CLOSE_CHECK_MILLIS = 3000;
const DIALOG_LISTER_SOURCE = path.join(__dirname, "dialogWindows.swift");
const DIALOG_LISTER = path.join(__dirname, "..", "out", "dialogWindows");

function ensureDialogLister() {
    if (fs.existsSync(DIALOG_LISTER)) return;
    fs.mkdirSync(path.dirname(DIALOG_LISTER), { recursive: true });
    execFileSync("xcrun", ["swiftc", "-O", "-o", DIALOG_LISTER, DIALOG_LISTER_SOURCE], { stdio: "inherit" });
}

function dialogWindows() {
    return JSON.parse(execFileSync(DIALOG_LISTER, { encoding: "utf-8" }));
}

function newDialogs(knownWindowIds) {
    return dialogWindows().filter((window) => !knownWindowIds.has(window.window_id));
}

function delay(millis) {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

async function waitUntilClosed(windowIds, timeoutMillis) {
    const deadline = Date.now() + timeoutMillis;
    while (Date.now() < deadline) {
        if (!dialogWindows().some((window) => windowIds.has(window.window_id))) return true;
        await delay(POLL_INTERVAL_MILLIS);
    }
    return false;
}

function parseLastLine(text) {
    const lines = text.trim().split("\n").filter((line) => line.length > 0);
    try {
        return JSON.parse(lines[lines.length - 1]);
    } catch {
        return text.trim() || null;
    }
}

function startCommand(command) {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const run = { child, output: "", finished: false };
    child.stdout.on("data", (chunk) => (run.output += chunk));
    child.stderr.on("data", (chunk) => (run.output += chunk));
    run.exited = new Promise((resolve) => child.on("exit", resolve)).then(() => (run.finished = true));
    return run;
}

// Polls until the command ends, a new dialog shows, or the timeout passes.
async function watch(run, knownWindowIds, startedAtMillis) {
    while (!run.finished && Date.now() - startedAtMillis < COMMAND_TIMEOUT_MILLIS) {
        const dialogs = newDialogs(knownWindowIds);
        if (dialogs.length > 0) return { dialogs, promptedAfterMillis: Date.now() - startedAtMillis };
        await delay(POLL_INTERVAL_MILLIS);
    }
    return { dialogs: [], promptedAfterMillis: null };
}

async function closeDialogs(dialogs) {
    const windowIds = new Set(dialogs.map((window) => window.window_id));
    const closedWithRequester = await waitUntilClosed(windowIds, CLOSE_CHECK_MILLIS);
    if (!closedWithRequester) {
        new Set(dialogs.map((window) => window.owner_pid)).forEach((ownerPid) => process.kill(ownerPid, "SIGTERM"));
    }
    return { dialog_closed_with_requester: closedWithRequester, dialog_closed: await waitUntilClosed(windowIds, CLOSE_CHECK_MILLIS) };
}

async function probe(label, command, waitForAnswer) {
    const knownWindowIds = new Set(dialogWindows().map((window) => window.window_id));
    const startedAtMillis = Date.now();
    const run = startCommand(command);
    const { dialogs, promptedAfterMillis } = await watch(run, knownWindowIds, startedAtMillis);
    const report = { label, other_dialogs_open: knownWindowIds.size };
    if (promptedAfterMillis === null && run.finished) {
        return { ...report, outcome: "completed", result: parseLastLine(run.output) };
    }
    if (promptedAfterMillis !== null && waitForAnswer) {
        await Promise.race([run.exited, delay(ANSWER_TIMEOUT_MILLIS)]);
        return { ...report, outcome: "prompted", prompted_after_millis: promptedAfterMillis,
            answered_after_millis: Date.now() - startedAtMillis, result: parseLastLine(run.output) };
    }
    process.kill(-run.child.pid, "SIGKILL");
    await run.exited;
    if (promptedAfterMillis === null) return { ...report, outcome: "hung" };
    return { ...report, outcome: "prompted", prompted_after_millis: promptedAfterMillis, ...(await closeDialogs(dialogs)) };
}

async function main() {
    ensureDialogLister();
    const separator = process.argv.indexOf("--");
    const label = process.argv[2];
    const waitForAnswer = process.argv.slice(3, separator).includes("--wait");
    console.log(JSON.stringify(await probe(label, process.argv.slice(separator + 1), waitForAnswer)));
}

main();
