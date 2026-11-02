#!/usr/bin/env node
"use strict";

const { runRemoteCommand } = require("./remote.cjs");

const USAGE = `usage: node src/main.cjs remote <scenario>
  Plays the CLI daemon: serves /ws/screen, waits for the Pinggy app, runs 1 scenario.
    status
    session [--reason TEXT] [--client NAME] [--pre-approved]
                         consent, 1 capture, 1 move to the screen center, end
    hold [--reason TEXT] [--client NAME] [--no-renew]
                         start a session, renew its grant, wait until the app ends it
    capture-without-session
    forged-grant | expired-grant | replayed-grant
                         each must answer grant_invalid with no dialog
    fake-provider        a browser Origin, then a forged proof, while the app is connected`;

async function main() {
    const [command, ...args] = process.argv.slice(2);
    const result = command === "remote" ? await runRemoteCommand(args) : null;
    console.log(result === null ? USAGE : JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
