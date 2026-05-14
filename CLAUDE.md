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

# Build platform binaries (via pkg)
npm run pack:all

# E2E suite against a packaged binary (see test/e2e/README.md)
node test/e2e/run.cjs out/pinggy-<platform>
```

## Architecture

### Two-process model

The CLI binary has 3 entry modes, dispatched in `src/main.ts`:

1. **Daemon child** (`--_daemon-child` flag). Calls `runDaemonChild()` in `src/daemon/daemonChild.ts`. The CLI re-execs itself with this flag when it needs to spawn a daemon; users never invoke it directly.
2. **Subcommand** (`config`, `start`, `stop`, `ps`, `attach`, `daemon`, `d`). Routes to `handleSubcommand()` in `src/cli/subcommands.ts`.
3. **Legacy single-tunnel** (no subcommand). Routes to `buildAndStartTunnel()` for flags like `-l 3000` or `-R0:localhost:3000`.

The daemon owns the `TunnelManager` singleton, the `@pinggy/pinggy` SDK, the web debugger server, and any `--serve` file servers. The CLI owns argument parsing, the TUI, the remote-management WebSocket client, and the IPC client to the daemon.

### IPC: HTTP + WebSocket on localhost

The daemon listens on `127.0.0.1` with an OS-assigned port (recorded in `daemon.json`):

- **HTTP** for request/response (`src/daemon/ipcServer.ts`): `GET /ping`, `GET /tunnels`, `POST /tunnels/start`, `POST /tunnels/start-config`, `POST /tunnels/stop`, `POST /tunnels/restart`, `POST /shutdown`, plus v1 compatibility routes used by remote management.
- **WebSocket** for streaming tunnel events (schema in `src/daemon/wsProtocol.ts`). Client subscribes by `tunnelId`; daemon emits `tunnel_event` frames keyed by event name.

CLI code calls `TunnelClient` (`src/daemon/tunnelClient.ts`), the public facade that combines HTTP RPC with WebSocket event dispatch. `IPCClient` (`src/daemon/ipcClient.ts`) is the raw HTTP wrapper underneath; nothing outside `tunnelClient.ts` should touch it.

### Daemon discovery and lifecycle

`getDaemonInfo()` in `src/daemon/daemonManager.ts` reads `daemon.json`, validates the PID with `process.kill(pid, 0)`, deletes the file if stale, and returns `null` if no live daemon is found. `startDaemon()` spawns a detached daemon child and polls `daemon.json` for up to 8s.

Single daemon per user. State lives under `~/.config/pinggy/` on Linux/macOS or `%APPDATA%/pinggy/` on Windows (helper: `src/utils/configDir.ts`):

- `daemon.json`: `{pid, port, startedAt}`.
- `daemon-state.json`: detached tunnel configs for crash recovery (`src/daemon/stateStore.ts`). Deleted on clean shutdown; replayed on next start.
- `daemon.log`: SDK + daemon logs. CLI logs stay separate.
- `tunnels/<name>_<configId>.json`: saved tunnel configs from `pinggy config save`.

### Foreground vs detached tunnels

`SessionTracker` (`src/daemon/sessionTracker.ts`) maps each `tunnelId` to a `sessionId` plus a mode:

- **Foreground**: CLI holds an open WebSocket subscription. If the subscription closes, a 5-second grace period starts; if no other CLI re-attaches, the daemon stops the tunnel.
- **Detached** (`-b` flag, or remote-management tunnels): tunnel persists in the daemon regardless of CLI presence and is recorded in `daemon-state.json`.

`pinggy attach <name|id>` reopens a foreground subscription and renders the TUI.

**Core types** are in `src/types.ts`: `TunnelStatus`, `Status`, `TunnelStateType` enum (`idle/starting/running/live/closed/exited`), `FinalConfig` (extends SDK's `TunnelConfigurationV1`). Browse `src/daemon/` and `src/cli/` for the rest of the module layout.

## Subcommands (user-facing)

| Command | Purpose |
|---|---|
| `pinggy config list \| show \| save \| update \| delete \| auto \| noauto` | CRUD on saved tunnel configs |
| `pinggy start <name...> [-b] [--all]` | Start saved tunnel(s). `-b` detaches; `--all` starts every auto-start config |
| `pinggy stop <name\|id>` | Stop running tunnel(s) by name or ID prefix |
| `pinggy ps` | Table of running tunnels (ID, name, status, local, URL) |
| `pinggy attach <name\|id>` | Re-attach TUI to a running tunnel |
| `pinggy daemon start \| stop \| status \| install-service \| uninstall-service` (alias `d`) | Daemon lifecycle and system-service installation |

## Build System

tsup bundles to `dist/` (CJS + ESM). tsc type-checks only (`npm run build:tsc`). pkg builds standalone platform binaries (`out/pinggy-<platform>`). ts-jest with the ESM preset for unit tests (`jest.config.cjs`).

## Testing

**Unit tests** live in `src/_tests_/`. Use `@jest/globals` imports (no global `jest`). `TunnelManager` is a singleton, so reset it between tests with `TunnelManager.instance = undefined`, and call `jest.clearAllMocks()` in `beforeEach`.

**End-to-end tests** live in `test/e2e/`. They run against a packaged `pkg` binary, spawn real Pinggy free-tier tunnels, and assert HTTP/TCP/UDP behavior over the live edge. See `test/e2e/README.md` for layout, framework helpers, and how to add a case. CI runs them across 6 platform binaries via `.github/workflows/e2e-test.yml`.

## Key Patterns

- **Singletons** inside the daemon: `TunnelManager`, Winston `logger`, `CLIPrinter`. Access via `getInstance()` or static methods.
- **Listener/observer maps** for SDK callbacks: `Map<tunnelId, Map<listenerId, fn>>`. Register/unregister by `listenerId` to avoid leaks.
- **Zod validation** on remote-management payloads (`src/remote_management/remote_schema.ts`), V1 and V2.
- **Worker threads** for file serving (`src/workers/file_serve_worker.ts`).
- **DaemonTunnelHandler**. Remote management lives in the CLI, but every tunnel operation it receives is forwarded to the daemon via this adapter in `src/daemon/tunnelClient.ts`. Same code path as user-typed subcommands.

## English Style

- **No em-dashes.** Use a period, colon, or restructure the sentence. No obvious characters or constructions used by LLMs and AI.
- **Short phrases.** Enough to convey technical meaning. Nothing more.
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
