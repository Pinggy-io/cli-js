# Plan: let the Pinggy app run the daemon in its own child process

Branch: `use-daemon-app` (this repo). Companion plan in the app repo, branch `use-daemon`:
`docs/PLAN_DAEMON_CHILD_PROCESS.md`. Read that one for the full picture; this file covers only
the cli-js side.

Status (2026-11-18): implemented on this branch, not published. Version is 0.6.10.
`npm test`: 877 pass, 25 fail; the same 25 fail without these changes (`tunnelManager.test.ts`,
`parseReverseTunnelAddr.test.ts`). `npm run build` passes. `npm run build:tsc` reports errors only
in `src/tui/ink/` (missing `ink` and `react`), as before. Open boxes below are what is left.

## Why

The desktop app loads this package in Electron's main process, and `ensureDaemonRunning()` hosts
the daemon there (`process.versions.electron` branch). libpinggy runs in that process, and it can
end the process: `ABORT_WITH_MSG` calls `exit(1)` in release builds, and a memory fault does the
same. The whole app then closes with no dialog. A Windows customer sees this every few days.

The app will start the daemon in a child process (Electron `utilityProcess`) and restart it when
it dies. This package needs to let a host supply its own way of starting the daemon, and needs a
few fixes so that restoring tunnels can safely happen many times.

## What the app will do with this package

1. In the main process: `setDaemonLauncher(launch)` once, before the first `ensureDaemon()`.
2. `launch()` forks a child script. The child calls
   `runDaemonChild({ host: DaemonHost.APP, exitOnFailure: false, skipAutoStart })` and reports
   back when it resolves.
3. On an unexpected child exit the app calls `removeDeadDaemonFiles(pid)`, then forks a new child.
   The new daemon restores detached tunnels from `daemon-state.json` (existing
   `restoreCrashedTunnels`).
4. On quit the app tells the child to call `handle.shutdown()`.

Contract the app relies on:

- With a launcher set, `ensureDaemonRunning()` never hosts the daemon in the calling process.
- With no launcher set, behaviour is exactly as today (old app builds keep working).
- `daemon.json` written by the child has `host: "app"`, so every existing `DaemonHost.APP` branch
  in the CLI keeps working (`pinggy daemon stop` refused, version-mismatch text, device agent
  text).
- `IPC_VERSION` does not change.

## Verified already (macOS arm64, Electron 45.3.3, pinggy 0.6.9)

- The native addon loads and a live tunnel runs inside an Electron utility process.
- Child killed with SIGKILL: `daemon-state.json` stays, and a new child restores the tunnel under
  the same tunnel id in about 2.3 s.
- `handle.shutdown()` then `process.exit(0)` in the child removes `daemon.json`, `daemon.lock` and
  `daemon-state.json`.
- When the Electron main process is killed, the child is gone within 0.2 s and its cleanup does
  not run.

## Work items

### A1. Launcher hook

- [x] `src/daemon/lifecycle/daemonManager.ts`

```ts
export type DaemonLauncher = () => Promise<void>;
let daemonLauncher: DaemonLauncher | null = null;

/** A host that starts the daemon its own way (the Pinggy app forks a child process). */
export function setDaemonLauncher(launcher: DaemonLauncher | null): void {
    daemonLauncher = launcher;
}
```

- [x] In `ensureDaemonRunning()` (currently line 228), between the "existing daemon" check and
  the `process.versions.electron` branch:

```ts
if (daemonLauncher) {
    await daemonLauncher();
    const info = await pollForDaemonInfo(DAEMON_SPAWN_TIMEOUT_MS);
    if (!info) throw new Error(`Daemon failed to start. Check ${getDaemonLogPath()} for details.`);
    if (!isIpcCompatible(info)) throw new Error(ipcMismatchMessage(info));
    return info;
}
```

  The launcher resolves when its daemon is ready, or when another daemon won `daemon.lock`. In
  both cases `daemon.json` names a live daemon, so the poll normally returns at once. The app's
  launcher is single-flight, so no serialising is needed here.
- [x] Update the doc comment above `ensureDaemonRunning()`.
- [x] Leave the Electron in-process branch and `getInProcessDaemonHandle()` as they are. They are
  the fallback for app builds that do not set a launcher.

### A2. Public exports

- [x] `src/index.ts`: export `setDaemonLauncher`, `runDaemonChild`, `DaemonHost`,
  `restorableTunnelCount`, `clearDaemonState`, `removeDeadDaemonFiles`, `DaemonLockHeldError`, and
  the types `DaemonHandle`, `RunDaemonOptions`, `DaemonLauncher`, `DaemonInfo`.
  - `restorableTunnelCount()` (new, `stateStore.ts`) replaced `isCrashRecovery()` here: the state
    file also exists with an empty tunnel list after normal use, so "the file exists" does not
    mean there is something to restore.
  - `runDaemonChild` and `DaemonHost` are exported from `src/main.ts` today, but not from the
    package entry, so the app cannot reach them.
- [x] New `removeDeadDaemonFiles(pid: number): void` in `daemonManager.ts`: delete `daemon.json`
  and `daemon.lock` when they name `pid`. The app calls it right after its child exits. Without
  it, both files name a dead pid until the next daemon starts, and a reused pid would read as a
  live daemon. Reuse `getDaemonInfoPath()` and `getDaemonLockPath()`.

- [x] New exported `DaemonLockHeldError`, thrown by `runDaemonChild()` in place of the plain
  `Error("Another pinggy daemon is running.")` when `exitOnFailure` is false (`daemonChild.ts`
  line 334). The app's child script needs to tell "another daemon won the lock" (exit 0, adopt
  it) from a real startup failure without matching on the message text.

### A3. Keep-alive race in the IPC client

- [x] `src/daemon/ipc/ipcClient.ts`, `request()` (line 172): add `agent: false` to the
  `http.request` options.

  The default global agent keeps sockets alive, and the daemon's HTTP server closes an idle
  socket after 5 s (`keepAliveTimeout` default). The heartbeat in `daemonHealth.ts` also runs
  every 5 s, so a ping can be written to a socket the server is closing: "Cannot connect to
  daemon: read ECONNRESET". Measured with the real defaults: 4 of 19 pings failed; with
  `agent: false`, 0 of 19. Two failures in a row declare the daemon lost.

### A4. Make tunnel restore safe to repeat

All in `src/daemon/lifecycle/daemonChild.ts`. These matter once restarts are automatic.

- [x] `restoreCrashedTunnels()` (line 255): seed the module-level `daemonState` from the loaded
  file, and remove each entry from the state (and persist) before attempting it.

  Today `daemonState` starts empty, and the first `trackTunnelStart()` rewrites
  `daemon-state.json` with only the tunnels restored so far. A second crash during restore loses
  the rest. And a tunnel that crashes libpinggy while it is being restored stays in the file, so
  every later start crashes again.

  After the change: an entry is in the file either because it has not been attempted yet or
  because it started. A tunnel that crashes the daemon during restore is dropped, not retried.

  Changed later (2026-11-18), see A4b: entries are no longer removed before the attempt.

```ts
daemonState = { tunnels: [...savedState.tunnels.filter(t => t.mode === "detached")], lastUpdated: "" };
persistDaemonState(daemonState);
for (const entry of detachedTunnels) {
    removeTunnelFromState(daemonState, entry.tunnelId);
    persistDaemonState(daemonState);
    try { /* create, start, trackTunnelStart as today */ } catch { /* logged as today */ }
}
```

- [x] `runDaemonChild()`: register `process.on("exit", cleanup)` only after startup succeeded
  (after "Daemon ready"). SIGTERM and SIGINT handlers can stay where they are.

  Today the handler is registered before `ipcServer.listen()`. A startup failure reaches
  `process.exit(1)` in the catch block, the `exit` handler runs `cleanup()`, and `cleanup()` calls
  `clearDaemonState()`. The tunnels to restore are lost because the daemon failed to start.
  The catch block already removes `daemon.json` and releases the lock.

- [x] New `RunDaemonOptions.skipAutoStart?: boolean` (default false). When true, skip the
  `getAutoStartConfigs()` loop (line 404).

  Every daemon start runs autostart, so after a crash an autostart tunnel that the user had
  stopped by hand starts again. The app sets this flag only on a supervised respawn. The first
  start, boot, and the CLI are unchanged.

### A4b. Restore all tunnels at the same time (added 2026-11-18)

A start is about 2 s of waiting for the server, and the restore ran one tunnel after another, so
the downtime was about 2.3 s per tunnel. Each tunnel has its own worker thread and the SDK has no
shared lock, so the starts can overlap.

- [x] `restoreCrashedTunnels()`: all tunnels through `Promise.all`, each in `restoreTunnel()`,
  which handles its own failure. No limit on how many at once (the Pinggy server has none).
- [x] The "remove the entry before the attempt" step is gone. An entry leaves the state file only
  when its start fails or the tunnel is stopped. A daemon that dies during the restore leaves all
  tunnels for the next one. A tunnel that crashes the daemon on every start now crashes each new
  daemon; the app's 5-crash guard stops that, and the app clears the file when it quits.
- [x] `newestPerConfig()`: the state file can hold 2 entries for 1 config (a tunnel that exited by
  itself stays in the file, and the config can be started again). Only the newest is restored.
  This comes from reading the code; it was not reproduced.
- [x] `stoppedWhileStarting()`: a tunnel stopped while it was starting is not tracked again. Used
  by the restore and by `startSavedTunnel()`.
- [x] Auto-start tunnels also start at the same time.
- [x] `daemonRestore.test.ts` rewritten: starts overlap; entries stay in the file while starting;
  a failed tunnel is dropped; a stopped one is not put back; 2 entries for 1 config restore once.
- Measured in the app with 6 tunnels: 3.7 s from the crash to all 6 serving (it would have been
  about 14.5 s). Killed again 0.6 s into the restore: all 6 came back. `pinggy stop <id>` during
  the restore: that tunnel stayed stopped and left the state file.

### A5. Event streams after a client re-binds

- [x] `src/daemon/tunnelClient.ts` `bindDaemon()` (line 133): after re-binding, subscribe again
  for every tunnel that has a stats or disconnect listener (`resubscribeShimListeners()`).
- [x] `src/daemon/ws/wsStream.ts` `terminate()`: clear the subscriptions even when the socket is
  already gone. A daemon that dies closes the socket first; `terminate()` then returned early, the
  old subscriptions stayed, and `subscribe()` on the new daemon sent nothing. Found in the app
  test: live stats stopped after a restart. Test: `wsStreamResubscribe.test.ts`.
- [x] `wsStream.ts` `ensureOpen()`: a 2nd caller while the socket is connecting waits for that
  socket. It used to open another one, and the 1st caller then sent on a socket that was not open
  ("WebSocket is not open: readyState 0"). Seen when 2 tunnels were re-subscribed at once.
- [x] `wsStream.ts` close handler: only clear `this.ws` when it is still the socket that closed.

  `WsStream.terminate()` (called on daemon loss) clears `subscribedTunnels`, and the listener
  shims subscribe only when a listener is registered (`subscribeForShim`, line 392). After the app
  re-binds its client to a new daemon, stats and disconnect listeners registered earlier stay
  silent. This comes from reading the code; confirm with a test before and after.

### A6. Wording

- [x] `src/cli/subcommand/handlers/daemonCommandsHandler.ts` line 130: `"Pinggy app (in-process)"`
  becomes `"Pinggy app"`.
- [x] `src/daemon/ipc/ipcServer.ts` (`Route.Shutdown`, line 297): reword the comment. The daemon
  may be the app's child, and the app restarts a daemon that exits. Keep the refusal for
  `DaemonHost.APP`, so `pinggy daemon stop` cannot take down the tunnels shown in the app.
- [x] `RunDaemonOptions.host` doc comment in `daemonChild.ts`: "in-process inside the app" becomes
  "owned by the app (in its process, or in a child process it supervises)".

### A7. Tests

Unit tests go in `src/_tests_/`, `@jest/globals` imports, temp config dir as in
`updateDaemonSpawn.test.ts`.

- [x] `daemonLauncher.test.ts`
  - launcher is called when no daemon runs, and its daemon info is returned;
  - launcher is not called when `daemon.json` names a live, compatible daemon;
  - a rejecting launcher's error reaches the caller;
  - a launched daemon that speaks another IPC version is refused.
  - Not written: `setDaemonLauncher(null)` restores the old path.
- [x] `daemonRestore.test.ts`: with 3 saved entries and a start that throws on the 2nd, the state
  file holds entries 1 and 3 afterwards; an entry is absent from the file while its start runs.
- [x] `removeDeadDaemonFiles`: removes files naming the pid, leaves files naming another pid.
- [x] `nativeLog.test.ts` and the existing daemon tests still pass.

### A8. Docs and version

- [x] `ARCHITECTURE.md` (repo root): the "Electron: calls ensuredaemon() ..." line in the daemon start
  flow (around line 92), the description of `host`, and the crash-recovery section (entries are
  removed before they are attempted; `skipAutoStart`).
- [x] `CLAUDE.md`: one sentence under "Daemon discovery and lifecycle" on `setDaemonLauncher`.
- [x] `npm run bump` (0.6.9 to 0.6.10).
- [x] Commits: plain description, no assistant attribution (see `CLAUDE.md`).
- [ ] Publishing to npm is done by the maintainer. Until then the app installs a tarball from
  `npm pack`.

## Things that do not change

- `daemon.lock`, `daemon.json`, `daemon-state.json` formats.
- `IPC_VERSION`.
- `pinggy daemon stop` refusal for an app-owned daemon.
- `process.versions.electron` users other than `ensureDaemonRunning()`: `installKind.ts` and
  `nodePtyRuntime.ts` behave the same in a utility process as in the Electron main process.

## Verification

1. Done. `npm run build:tsc`, `npm test`, `npm run build` (results in "Status" above).
2. Done, with a scratch `HOME` and no launcher set: `pinggy daemon start` (with an autostart
   tunnel), `pinggy ps`, `pinggy daemon status`, `pinggy daemon stop` behave as before.
3. Covered by `daemonRestore.test.ts` only. Seen once live with 1 tunnel (daemon killed 0.8 s into
   a restore: the tunnel was dropped and the state file was left with an empty list). The
   3-tunnel live run is not done.
4. Not run.
5. The app-side checks are in the app repo's plan; all macOS ones pass.

## Not in this plan

- A client-only entry point, so the app's main process would not load the native addon at all.
- Killing a hung daemon from the app. The heartbeat only runs while a WebSocket is open and can
  miss two pings across sleep and wake.
- Making libpinggy throw instead of calling `exit(1)`.
