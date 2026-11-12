## Project Overview 

Pinggy CLI (`@pinggy/cli`) is a Node.js CLI tool for creating and managing Pinggy tunnels. It runs as **two processes**: a short-lived foreground CLI that the user invokes, and a long-running daemon that owns every tunnel. The CLI talks to the daemon over HTTP + WebSocket on `127.0.0.1`. Built with TypeScript, wraps the `@pinggy/pinggy` SDK in the daemon, and ships a blessed-based TUI plus remote control via WebSocket.

## Common Commands

```bash
# Build (produces CJS + ESM in dist/)
npm run build

# TypeScript type-check only (output to dist_tsc/)
npm run build:tsc

# Dev workflow (link SDK, build, link locally)
npm run dev

# Build platform binaries (via pkg). Linux binaries need Linux and Docker: see Build System
npm run pack:all

# E2E suite against a packaged binary (see test/e2e/README.md)
node test/e2e/run.cjs out/pinggy-<platform>
```

## Architecture

### Two-process model

The CLI binary has 4 entry modes, dispatched in `src/main.ts`:

1. **Daemon child** (`--_daemon-child` flag). Calls `runDaemonChild()` in `src/daemon/daemonChild.ts`. The CLI re-execs itself with this flag when it needs to spawn a daemon; users never invoke it directly.
2. **Subcommand** (`config`, `start`, `stop`, `ps`, `attach`, `daemon`, `d`, `device`, `devices`, `update`). Routes to `handleSubcommand()` in `src/cli/subcommands.ts`.
3. **Legacy single-tunnel** (no subcommand). Routes to `buildAndStartTunnel()` for flags like `-l 3000` or `-R0:localhost:3000`.
4. **Update child** (`--_update-child` flag). Calls `runUpdateChild()` in `src/update/updateChild.ts`. A command starts it at most once a day, detached, to check for a release and install it.

The daemon owns the `TunnelManager` singleton, the `@pinggy/pinggy` SDK, the web debugger server, and any `--serve` file servers. The CLI owns argument parsing, the TUI, the remote-management WebSocket client, and the IPC client to the daemon.

### IPC: HTTP + WebSocket on localhost

The daemon listens on `127.0.0.1` with an OS-assigned port (recorded in `daemon.json`):

- **HTTP** for request/response (`src/daemon/ipcServer.ts`): `GET /ping`, `GET /tunnels`, `POST /tunnels/start`, `POST /tunnels/start-config`, `POST /tunnels/stop`, `POST /tunnels/restart`, `POST /shutdown`, plus v1 compatibility routes used by remote management.
- **WebSocket** for streaming tunnel events (schema in `src/daemon/wsProtocol.ts`). Client subscribes by `tunnelId`; daemon emits `tunnel_event` frames keyed by event name.

CLI code calls `TunnelClient` (`src/daemon/tunnelClient.ts`), the public facade that combines HTTP RPC with WebSocket event dispatch. `IPCClient` (`src/daemon/ipcClient.ts`) is the raw HTTP wrapper underneath; nothing outside `tunnelClient.ts` should touch it.

### Daemon discovery and lifecycle

`getDaemonInfo()` in `src/daemon/daemonManager.ts` reads `daemon.json`, validates the PID with `process.kill(pid, 0)`, deletes the file if stale (dead PID, or `startedAt` before the last boot), and returns `null` if no live daemon is found. `startDaemon()` spawns a detached daemon child and polls `daemon.json` for up to 8s.

Single daemon per user. State lives under `~/.config/pinggy/` on Linux/macOS or `%APPDATA%/pinggy/` on Windows (helper: `src/utils/configDir.ts`):

- `daemon.json`: `{pid, port, startedAt, host, ipcVersion, cliVersion}`. `cliVersion` is the version the daemon started with, and never follows the installed binary. `ipcVersion` is `IPC_VERSION` from `src/daemon/ipc/ipcRoutes.ts`. `ensureDaemonRunning()` refuses a live daemon whose version differs and tells the user to run `pinggy daemon stop`. Bump `IPC_VERSION` on any incompatible IPC or WebSocket change. After an update the CLI is newer than the daemon, often for weeks, so a new IPC route or WebSocket frame needs a capability check or an `IPC_VERSION` bump.
- `daemon.lock`: `{pid, started_at}` of the running daemon (`src/daemon/lifecycle/daemonLock.ts`). Each daemon takes it before it opens its IPC port, and a daemon that finds a live holder exits 0. systemd and launchd run `--_daemon-child` directly, and 2 CLIs can spawn at once, so the CLI's `daemon.json` check alone does not keep 1 daemon.
- `daemon-state.json`: detached tunnel configs, for crash recovery (`src/daemon/lifecycle/stateStore.ts`). Deleted on clean shutdown; replayed on next start.
- `daemon-config.json`: settings that survive a clean shutdown (`src/daemon/lifecycle/daemonConfig.ts`): the log level, and `deviceAgent`, set while the background device agent should run. Every daemon start runs that agent. `pinggy device remove` deletes it. `pinggy device stop` keeps it, so the agent starts again with the next daemon.
- `daemon.log`: SDK + daemon logs. CLI logs stay separate.
- `tunnels/<name>_<configId>.json`: saved tunnel configs from `pinggy config save`.
- `device.json`: device agent id and token from `pinggy device connect` (`src/devices/deviceIdentity.ts`). Written 0600, unlike the tunnel configs beside it.
- `device-agent.json`: `{pid, started_at}` of a device agent started with `--foreground`, while it runs (`src/devices/foregroundAgent.ts`). `pinggy device remove` deletes it, and the agent stops within 1 s. No credential.

### Foreground vs detached tunnels

`SessionTracker` (`src/daemon/sessionTracker.ts`) maps each `tunnelId` to a `sessionId` plus a mode:

- **Foreground**: CLI holds an open WebSocket subscription. If the subscription closes, a 5-second grace period starts; if no other CLI re-attaches, the daemon stops the tunnel.
- **Detached** (`-b` flag, or remote-management tunnels): tunnel persists in the daemon regardless of CLI presence and is recorded in `daemon-state.json`.

`pinggy attach <name|id>` reopens a foreground subscription and renders the TUI.

### Device agent

`pinggy device` enrols this machine with the dashboard and holds 1 WebSocket open to it. Code lives in `src/devices/`, entered from `src/cli/subcommand/handlers/deviceCommand.ts`.

`pinggy devices`, the old spelling, stays a subcommand that prints the new one and exits 1 (`refuseDevicesSpelling()`). Do not remove `Subcommand.Devices`: without it `devices` falls to legacy tunnel mode, where `--token` is the tunnel token, so `pinggy devices connect --token pga_...` would send the device token to the tunnel server.

It owns no tunnel. It reads the daemon's `GET /tunnels` through `IPCClient` and the saved configs, to send `device/tunnels` (`src/devices/tunnels/tunnelList.ts`), and listing never starts a daemon. It stops, restarts and starts tunnels when the dashboard asks (`src/devices/tunnels/tunnelActions.ts`), through `IPCClient` with the `device` origin; only a start of a config may call `ensureDaemonRunning()`. It also applies an updated dashboard config to the tunnel running it, through the daemon's `update-config-v2`, and it rewrites a saved config's file when the dashboard edits it (`upsertConfig()`, no daemon). `pinggy device login` signs the machine in by email over plain HTTPS (`src/devices/login/`), writes `device.json`, then runs the same agent; the sign-in can also be approved from the email's link, and the poll collects it. No `TunnelManager`. It also does not reuse `src/remote_management/`, which is a tunnel controller keyed by an API key rather than the machine keyed by a device token. Frames use a versioned envelope (`src/devices/envelope.ts`) validated with zod (`src/devices/device_schema.ts`); an unknown `ch` or `op` is ignored, never fatal.

`pinggy device connect` and `login` run the agent in the daemon, as `pinggy start -b` runs a tunnel there, so it outlives the terminal. `--foreground` runs it in the CLI process instead, until Ctrl+C. `-b` still parses and changes nothing; `-b` with `--foreground` exits 1. `--foreground` sits hidden in `cliOptions`, because `main.ts` parses the whole command line with it, strict, before it dispatches. Whoever hosts the daemon, the CLI's child or the Pinggy app, hosts the agent (`src/daemon/deviceAgentHost.ts`, `src/devices/backgroundAgent.ts`). `GET /device`, `POST /device/start` and `POST /device/stop` reach it, and `TunnelClient` exposes them for the app. No IPC route takes or returns a token or a server: the daemon reads both from `device.json`, and a new token is checked in the CLI with 1 handshake before the daemon sees it. Once the daemon starts the agent, the CLI prints the commands that manage it (`status`, `stop`, `connect`, `remove`). `pinggy device stop` stops it. A `--foreground` `connect` or `login` refuses while it runs. The loop prints nothing itself: it calls a `DeviceAgentReporter`, and the foreground's prints the same lines as before.

1 invocation runs 1 subcommand: `isSubcommand()` reads `rawArgs[0]` only, so `pinggy device connect start my-tunnel` runs the agent and drops the rest, and tunnel flags on a `device` line parse and are ignored, except `-b` and `--foreground`.

`scripts/install/install.sh` installs into `~/.pinggy/versions/<version>/` and points the link `~/.pinggy/bin/pinggy` at it. `install.sh` and `install.ps1` install or update the binary, put it on PATH, then ask "Connect this device to Pinggy? [Y/n]" and run `pinggy device login -b` unless the answer starts with `n`. `-b` is the default, and the scripts pass it so an older binary the user kept also runs the agent in its daemon. pinggy.io serves copies that `website-cli-download-links-pr.yml` writes at each release tag. The scripts read the version to install from `https://pinggy.io/cli/version.json`, which the website builds from the `data/cli_releases.yaml` that the same PR updates, and they exit 1 when it does not answer. They download the binary from the GitHub release. The updater in `src/update/` still reads GitHub's `/releases/latest`. Copies of the scripts stay in use, so that URL and its `version` field never change. Renaming a release asset, changing the `Pinggy CLI version:` line, or changing `device login`'s `--manage` or `-b` flag means changing both scripts in the same commit. `DEVICE_AGENT_TOKEN` on either script still gets every update question, then runs `pinggy device connect -b` instead, with the token in the environment, never on a command line. `handleDevice()` deletes the variable from `process.env` before any verb runs, so no shell or daemon the agent starts inherits it. Renaming the variable or `connect`'s `--manage` or `-b` flag also changes both scripts in the same commit. Both scripts update the copy the `pinggy` command runs: an npm copy with `npm install -g --prefix`, the binary otherwise. A copy from `npm link`, pnpm, yarn or bun stops them, and a binary they did not install gets a question first (ARCHITECTURE.md, "Which copy the scripts update"). They tell an npm copy by the `lib/node_modules/pinggy/` path that npm writes. `pinggy daemon service-install` runs only from the path the scripts install to (`installerBinaryPath()` in `src/daemon/lifecycle/serviceInstaller.ts`), so changing either script's install directory changes that function in the same commit. Once the device connects, both scripts offer `pinggy daemon service-install` unless the service exists. They look for the task name, plist or unit file that `serviceInstaller.ts` writes, and the installed binary's path in it, so renaming any of them changes both scripts in the same commit.

Section 17 of `ARCHITECTURE.md` has the protocol, the retry and terminal outcome table, the `device.json` rules, and the full composition table. The design docs are in the `pinggy_backend` repo under `docs/pinggy-devices/`; read `cli.md` there before changing anything in `src/devices/`.

**Core types** are in `src/types.ts`: `TunnelStatus`, `Status`, `TunnelStateType` enum (`idle/starting/running/live/closed/exited`), `FinalConfig` (extends SDK's `TunnelConfigurationV1`). Browse `src/daemon/` and `src/cli/` for the rest of the module layout.

## Subcommands (user-facing) 

| Command | Purpose |
|---|---|
| `pinggy config list \| show \| save \| update \| delete \| auto \| noauto` | CRUD on saved tunnel configs |
| `pinggy start <name...> [-b] [--all]` | Start saved tunnel(s). `-b` detaches; `--all` starts every auto-start config |
| `pinggy stop <name\|id>` | Stop running tunnel(s) by name or ID prefix |
| `pinggy ps` | Table of running tunnels (ID, name, status, local, URL) |
| `pinggy attach <name\|id>` | Re-attach TUI to a running tunnel |
| `pinggy daemon start \| stop \| status \| service-install \| service-uninstall` (alias `d`) | Daemon lifecycle and system-service installation |
| `pinggy update [--check \| --rollback]` | Update to the latest release now, print the latest version and change nothing, or go back to the previous version. A background check starts on its own; `PINGGY_AUTO_UPDATE=false` turns it off |
| `pinggy device login \| connect [--foreground] \| stop \| status \| remove [-f]` | Sign this machine in by email, or enrol it with a token, as a Pinggy device; the agent runs in the daemon, or in this terminal with `--foreground`, and `stop` stops the daemon's; show whether the agent runs, the enrolment and the background agent; show the device and its connection, ask, then stop every agent and forget the credential (`-f` skips the question) |

### Auto-update

`src/update/` updates the CLI from GitHub releases. Section 20 of `ARCHITECTURE.md` has the flow. 3 rules hold for every change:

- Each installed copy keeps the updater it shipped with, so these never change: the `/releases/latest` redirect, the tag format `vX.Y.Z`, the 6 asset names, `SHA256SUMS` and its format, the `Pinggy CLI version: <x.y.z>` line, the `--_ipc-version` output, and the `update.json` field names.
- A rollback runs older code against `daemon-state.json`, `device.json` and saved configs, so they change by adding fields only.
- `SHA256SUMS` is the last upload of a release. A release that has it counts as complete.

## Build System

tsup bundles to `dist/` (CJS + ESM). tsc type-checks only (`npm run build:tsc`). pkg builds standalone platform binaries (`out/pinggy-<platform>`). ts-jest with the ESM preset for unit tests (`jest.config.cjs`).

pkg packs every file in a dependency's `files` list and every package in its `dependencies`, whether the code loads it or not. The `pkg.ignore` list in `package.json` keeps out what the binary never loads: node-pty's `.pdb` debug symbols and C++ source, the SDK's unlinked `libcrypto.dylib` and `libssl.dylib` copies, the SDK's install-time `node-gyp` and `@mapbox/node-pre-gyp`, and zod's `src/` and `v3/`. A new glob must not match node-pty's `package.json`, `lib/`, `build/Release/pty.node`, or any file under `prebuilds/` other than a `.pdb`: `resolveNodePtyRoot()` copies those out of the snapshot at runtime. node-pty has no Linux prebuild, so on Linux `npm ci` compiles `build/Release/pty.node`. Its `files` list leaves `build/` out, so `pkg.assets` names that file. Without it the Linux binary offers no terminal. Pack a Linux binary on Linux, on the architecture it targets: `npm ci`, then `scripts/build_node_pty_linux.sh` (needs Docker), then `pack:linux-<arch>`. The script compiles `pty.node` in `node:24-bookworm`, because one compiled on a newer distro needs a newer glibc: from `ubuntu-latest` (Ubuntu 26.04) it needs `GLIBC_2.42` and does not load on Ubuntu 24.04. `pack:linux-<arch>` first runs `scripts/check_linux_addons.js` on `pty.node` and the SDK's `addon.node` and `libpinggy.so`. It refuses a missing file, one for another architecture, and one that needs a symbol version RHEL 9's glibc 2.34, libgcc_s or libstdc++ lacks. So `pack:all` and `pack:linux` fail on macOS, and `pack:linux` fails at its 2nd architecture. The `**` in these globs does not match a folder whose name starts with a dot, so a checkout under such a path (`~/.work/cli-js`) ignores nothing and builds the full-size binary. `"compress": "Brotli"` compresses the snapshot: on macOS arm64 the binary drops from 83 MB to 59 MB, and each run starts about 80ms later.

## Testing

**Unit tests** live in `src/_tests_/`. Use `@jest/globals` imports (no global `jest`). `TunnelManager` is a singleton, so reset it between tests with `TunnelManager.instance = undefined`, and call `jest.clearAllMocks()` in `beforeEach`.

**End-to-end tests** live in `test/e2e/`. They run against a packaged `pkg` binary, spawn real Pinggy free-tier tunnels, and assert HTTP/TCP/UDP behavior over the live edge. See `test/e2e/README.md` for layout, framework helpers, and how to add a case. CI runs them across 6 platform binaries via `.github/workflows/e2e-test.yml`. CI sets `PINGGY_E2E_SUITE=ci`, which runs 3 combined cases in place of 15 separate ones. The default `full` suite runs the separate ones. A change to a separate case needs the same change in its combined case.

## Key Patterns

- **Singletons** inside the daemon: `TunnelManager`, Winston `logger`, `CLIPrinter`. Access via `getInstance()` or static methods.
- **Listener/observer maps** for SDK callbacks: `Map<tunnelId, Map<listenerId, fn>>`. Register/unregister by `listenerId` to avoid leaks.
- **Zod validation** on remote-management payloads (`src/remote_management/remote_schema.ts`), V1 and V2.
- **Worker threads** for file serving (`src/workers/file_serve_worker.ts`).
- **DaemonTunnelHandler**. Remote management lives in the CLI, but every tunnel operation it receives is forwarded to the daemon via this adapter in `src/daemon/tunnelClient.ts`. Same code path as user-typed subcommands.

## English Style

- **Hyphen only.** The hyphen (-) is the only dash. No em-dash and no en-dash anywhere in any file. This includes numeric ranges (write 1-20) and empty-cell placeholders in tables. Use a period, a colon, or restructure the sentence instead.
- **No AI-sounding text.** Do not use words, phrases, or symbols typical of LLM output.
- **No emoji in the codebase.** Documentation may use one only if it is very apt.
- **Simple English.** Say things in a straightforward way. Keep every technical term and its exact meaning. Use simple but accurate technical terms, not jargon.
- **Short phrases.** Enough to convey technical meaning. Nothing more.
- **No metaphor or personification** in technical statements. State the behavior literally. Write "a partial report is scored and enters the benchmark", never "a partial is a full citizen".
- **No filler words.** Cut: "in order to", "it is important to note", "please note that", "essentially", "basically", "simply".
- **No passive voice** unless the subject is unknown or irrelevant.
- **No nominalizations.** Prefer "detect" over "perform detection"; "configure" over "apply configuration".
- **One idea per sentence.** Split compound sentences.
- **No throat-clearing openers.** Never start with "This document describes...", "The purpose of this is...", "As mentioned above...".
- **Prefer concrete over abstract.** Name the thing: `navigator.webdriver`, not "the relevant browser property".
- **Present tense.** "The system routes requests." Not "The system will route requests."
- **No redundant qualifiers.** "Persistent storage" not "persistent, durable, long-lived storage".
- **Numbers.** Use digits for all quantities: "3 retries", "50 sessions", "300ms".

## Code Style
- **No dead code.** Remove unused imports, functions, and variables immediately. `ruff` enforces this.
- **Small functions.** If a function needs a comment to explain its sections, split it.

## Answering Questions

- **A question is not a change request.** When asked a question, do not change code. Answer it.

## Commit Messages

- **Plain change description.** Write the message as a human author would: what changed and why.
- **No assistant attribution.** Do not mention Claude, AI, or any assistant. No `Co-Authored-By` assistant trailer, no "Generated with" line, no tool attribution.
