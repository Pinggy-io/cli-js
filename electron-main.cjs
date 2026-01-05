#!/usr/bin/env node
const { app } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");


app.disableHardwareAcceleration();

if (app.requestSingleInstanceLock()) {
  app.on("ready", () => {
    const cliEntry = path.join(__dirname, "dist_tsc", "index.js");

    console.log(`Starting CLI process: ${cliEntry}`);
    const args = process.argv.slice( app.isPackaged ? 1 : 2 );

    // const child = utilityProcess.fork(cliEntry, process.argv.slice(1), {
    //   stdio: "inherit"
    // });

    const child = spawn(process.execPath, [cliEntry, ...args], {
    stdio: "inherit", 
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });

    child.on("exit", (code) => {
      app.quit();
      process.exit(code ?? 0);
    });

    process.on('SIGINT', () => child.kill());
    process.on('SIGTERM', () => child.kill());
  });
}

app.on("window-all-closed", (e) => e.preventDefault());