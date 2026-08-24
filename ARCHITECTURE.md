x# Pinggy CLI Architecture

Reference for developers and AI agents working on the `@pinggy/cli` codebase. Covers the two-process daemon model, IPC, state, session ownership, and module layout introduced on the `feat/daemon` branch.

For domain language (Tunnel, Daemon, Client, Origin, Foreground mode, etc.) see `CONTEXT.md`. For project rules and English style see `CLAUDE.md`. This file documents how the pieces fit together.

## 1. The two-process model

The `pinggy` binary has three execution modes, dispatched in `src/main.ts`:

| Mode                 | Trigger                          | Entry                                                           | Purpose                                                                                                                     |
| -------------------- | -------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Daemon child         | `--_daemon-child` flag         | `runDaemonChild()` in `src/daemon/daemonChild.ts`           | Long-running background process. Owns the `TunnelManager` and the SDK.                                                    |
| Subcommand           | First arg in `SUBCOMMANDS` set | `handleSubcommand()` in `src/cli/subcommands.ts`            | Short-lived CLI invocation:`config`, `start`, `stop`, `ps`, `attach`, `daemon`, `logs`, `log`, `restart`. |
| Legacy single-tunnel | No subcommand, has flags         | `buildAndStartTunnel()` in `src/cli/buildAndStartTunnel.ts` | Backwards-compatible single-shot tunnel for flags like `-l 3000` or `-R0:...`.                                          |

The CLI never opens an SDK tunnel itself. Every tunnel is created inside the daemon. CLI processes talk to the daemon over HTTP + WebSocket on `127.0.0.1`.

![1779362797675](image/ARCHITECTURE/1779362797675.png)

A given user has **one** daemon. Whichever client (CLI or App) finds no live daemon spawns one; later clients discover it via `daemon.json`.

## 2. Filesystem layout

State lives under `getPinggyConfigDir()` (`src/utils/configDir.ts`):

- Linux: `$XDG_CONFIG_HOME/pinggy` (default `~/.config/pinggy`)
- macOS: `~/.config/pinggy`
- Windows: `%APPDATA%/pinggy`

Logs live under `getPinggyLogDir()`:

- Linux: `$XDG_STATE_HOME/pinggy-cli/logs`
- macOS: `~/Library/Logs/Pinggy-CLI`
- Windows: `%LOCALAPPDATA%/Pinggy-CLI/Logs`

```
<configDir>/
├── daemon.json                  Daemon discovery: {pid, port, startedAt}
├── daemon-state.json            Active tunnel snapshot for crash recovery
└── tunnels/
    └── <name>_<configId>.json   Saved tunnel configs (from `pinggy config save`)

<logDir>/
├── daemon.log                   Daemon process log (rolled)
└── tunnels/
    └── <origin>__<name>__<tunnelId>.log   Per-tunnel logs (rolled 10MB×3)
```

Helpers live in `src/utils/configDir.ts`: `getDaemonInfoPath`, `getDaemonLogPath`, `getTunnelLogPath`, `getTunnelConfigDir`.

## 3. Daemon discovery and spawn

Every CLI invocation that touches a tunnel asks one question first: is there a live daemon to talk to? `getDaemonInfo()` answers it by reading `daemon.json` and validating the recorded PID with `process.kill(pid, 0)`. Signal 0 never delivers anything; it just throws when the target process is gone, which is exactly the liveness probe we need. A missing file, malformed JSON, or a dead PID all collapse to the same result: return `null`, and let `ensureDaemonRunning()` spawn a fresh child.

The spawn path is deliberately one-way. The CLI fires off a detached child with the `--_daemon-child` flag and then polls `daemon.json` until the child writes it. The poll budget is 8 seconds at 200ms intervals; a timeout almost always means the SDK failed to load inside the child, in which case the stderr captured from the spawned process is surfaced in the thrown error. Atomic writes of `daemon.json` (write to `.tmp`, then `fs.renameSync`) keep concurrent readers from ever seeing a half-written file.

```
   CLI starts
       │
       ▼
   getDaemonInfo()  ─── reads daemon.json
       │
       ├─ file missing            ──▶ return null
       ├─ malformed               ──▶ return null
       ├─ PID dead (kill -0 fails)──▶ unlink daemon.json, return null
       └─ PID alive               ──▶ return DaemonInfo
       │
       ▼
   has DaemonInfo? ─── yes ──▶ connect IPCClient(port)
       │
       no
       ▼
   startDaemon()
       │
       ├─ spawn detached child with --_daemon-child
       │    Unix: spawn(execPath, [argv[1], "--_daemon-child"], {detached, stdio: pipe-stderr})
       │    Windows: same + windowsHide:true
       │    Electron: calls ensuredaemon() which internally starts the daemon server if no daemon is there
       │
       ├─ child.unref()
       │
       └─ pollForDaemonInfo(8000ms, interval 200ms)
            │
            ├─ daemon.json appears   ──▶ return DaemonInfo
            ├─ child exits early     ──▶ throw with stderr
            └─ timeout               ──▶ throw "Daemon failed to start within timeout"
```

Implementation: `src/daemon/daemonManager.ts`. 

The race between two CLIs invoked at the same moment is bounded but not eliminated: both may observe no `daemon.json`, both may spawn a child. Whichever child's atomic write lands last wins the file; the other daemon is reachable via its port but unreachable through discovery, and dies when its IPC server is closed or its parent CLI exits. In practice this is rare enough that we accept it; tightening it would require a file lock and adds more complexity than it removes.

## 4. Daemon child startup sequence

`runDaemonChild()` runs once per daemon lifetime, inside the spawned child process. The step order matters: signal handlers must register before any work that could throw, the IPC port must be open before `daemon.json` is written, and crash recovery must run before auto-start so a restored tunnel never races a freshly-spawned auto-start one.

`runDaemonChild()` in `src/daemon/daemonChild.ts`:

```
1. ensurePinggyConfigDir(), ensurePinggyLogDir()
2. Configure winston logger → file: daemon.log, stdout: false
3. Create TunnelManager singleton
4. Create IPCServer (HTTP + WS, port not yet bound)
5. Create SessionTracker, wire onSessionDisconnect
6. Register signal handlers: SIGTERM, SIGINT, exit, uncaughtException
7. ipcServer.listen() → returns OS-assigned port
8. Write daemon.json atomically (write to .tmp, rename)
9. restoreCrashedTunnels() — replay detached tunnels from daemon-state.json
10. Start auto-start tunnels (getAutoStartConfigs())
11. Log "Daemon ready"


```

Step 8 is the contract the rest of the system depends on: once `daemon.json` exists with a live PID, the IPC server is already accepting connections. CLIs that read the file can immediately POST or open a WebSocket; there is no "warming up" window. Steps 9 and 10 may take time when the Pinggy edge is slow, so "Daemon ready" only means the daemon is reachable, not that every tunnel is live. Callers that need tunnel readiness must poll `/tunnels` or subscribe to `url_ready` over the WebSocket.

## 5. IPC: HTTP routes

HTTP carries every request/response operation: start, stop, list, restart, log management, shutdown. The transport is plain `http` on `127.0.0.1` with an OS-assigned port. Loopback isolation is the security boundary; there is no auth on these routes, so binding anywhere other than `127.0.0.1` is unsafe.

Server: `src/daemon/ipcServer.ts`. Client: `src/daemon/ipcClient.ts`. Public facade: `src/daemon/tunnelClient.ts`.

| Method | Path                                                        | Purpose                                         |
| ------ | ----------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/ping`                                                   | Health + uptime                                 |
| GET    | `/tunnels`                                                | List V2                                         |
| GET    | `/tunnels/:id`                                            | Get one                                         |
| POST   | `/tunnels/start`                                          | Start by saved-config name                      |
| POST   | `/tunnels/start-config`                                   | Start with inline V2 config                     |
| POST   | `/tunnels/stop`                                           | `{tunnelid}`                                  |
| POST   | `/tunnels/restart`                                        | `{tunnelid}`                                  |
| GET    | `/tunnels-v1`                                             | List V1 (compat)                                |
| POST   | `/tunnels/start-v1`                                       | V1 start (used by remote management)            |
| POST   | `/tunnels/update-config`                                  | V1 update                                       |
| POST   | `/tunnels/update-config-v2`                               | V2 update                                       |
| POST   | `/tunnels/remove-stopped`                                 | Remove a stopped tunnel by tunnelid or configId |
| GET    | `/loglevel`, POST `/loglevel`                           | Daemon-wide log level                           |
| GET    | `/config/tunnel-logging`, POST `/config/tunnel-logging` | Tunnel logging toggle                           |
| GET    | `/logs/paths`                                             | All tunnel log file paths + running flags       |
| GET    | `/logs/resolve?q=`                                        | Resolve a name/id/configId to a log path        |
| POST   | `/shutdown`                                               | Graceful shutdown                               |

Conventions:

- Every request sets `X-Pinggy-Origin: app|cli|remote` (defaulted in `parseOrigin()` to `cli`). Stored on the tunnel and used in log filenames.
- V2 is the canonical shape. V1 routes (`/tunnels-v1`, `/tunnels/start-v1`, `/tunnels/update-config`) exist for remote management payloads that still use the older schema. New code should target V2.
- `start` is idempotent on `configId`. If a tunnel with the same `configId` is already running, the daemon returns `ErrorResponse{code: TunnelAlreadyRunningError}` and the CLI prints the existing state instead of starting a duplicate.
- A successful operation returns its typed response with HTTP 200. An expected application-level failure returns `ErrorResponse` JSON, still with HTTP 200; the route handled the request, the operation just failed. Non-200 means a transport-level problem (daemon died mid-request, port in use after spawn, etc.) and surfaces as a thrown error in `IPCClient`.
- The `mode` field (added to `start`, `start-config`, `start-v1`) tells `trackIPCTunnelStart` whether to persist the tunnel to `daemon-state.json`. Foreground tunnels are not persisted; detached tunnels are. The default is `"detached"`, which is what remote management and `DaemonTunnelHandler` rely on.

## 6. IPC: WebSocket event stream

Path: `ws://127.0.0.1:<port>/ws`. Schema in `src/daemon/wsProtocol.ts`.

Client → Daemon:

```
{ type: "subscribe",   tunnelId: "...", mode: "foreground" | "detached" }
{ type: "unsubscribe", tunnelId: "..." }
```

Daemon → Client (always wrapped in a `tunnel_event`):

```
{
  type: "tunnel_event",
  tunnelId: "...",
  event: "url_ready" | "stats" | "disconnect" | "reconnecting" | "reconnected"
       | "reconnection_failed" | "error" | "stopped" | "will_reconnect"
       | "worker_error" | "subscribed" | "error_response",
  payload: { ... }
}
```

On `subscribe`, the daemon registers a fan-out of listeners against `TunnelManager` for the tunnel and remembers their listener IDs on the session. On `unsubscribe` or session close, every listener is deregistered. See `handleSubscribe`, `deregisterListeners`, `cleanupSession` in `ipcServer.ts`.

```
Subscribe sequence:

  CLI                          Daemon                       TunnelManager
   │  ws.send(subscribe)          │                                │
   ├──────────────────────────────▶                                │
   │                              │ registerStatsListener          │
   │                              ├───────────────────────────────▶│
   │                              │ registerDisconnectListener     │
   │                              ├───────────────────────────────▶│
   │                              │ (… 7 more listeners)           │
   │                              │                                │
   │                              │ commit subscription            │
   │                              │ sessionTracker.attach(tid, sid, mode)
   │  tunnel_event "subscribed"   │                                │
   ◀──────────────────────────────┤                                │
   │                              │   stats fired ◀────────────────│
   │  tunnel_event "stats"        │                                │
   ◀──────────────────────────────┤                                │
```

The CLI side dispatches each `tunnel_event` to user-registered callbacks via `TunnelClient.handleWsMessage`. Callbacks are stored per event type in arrays (`callbacks.stats`, `callbacks.disconnect`, etc.)

## 7. Foreground vs detached: SessionTracker

`SessionTracker` in `src/daemon/sessionTracker.ts` tracks ownership of each running tunnel.

```
ownership: Map<tunnelId, { sessionId, mode: "foreground" | "detached" }>
graceTimers: Map<tunnelId, NodeJS.Timeout>
```

State machine for a tunnel:

```
                     subscribe(mode="foreground")
       ┌──────────────────────────────────────────────┐
       │                                              ▼
   (no owner)                                  FOREGROUND
       │  ▲                                           │
       │  │                                           │ WS session disconnects
       │  │                                           ▼
       │  │                                    GRACE (5000ms)
       │  │     subscribe(mode="foreground")          │
       │  │   (another CLI re-attaches)               │
       │  │ ◀────────────────────────────────────────┤
       │  │                                           │ timer expires
       │  │                                           ▼
       │  └─────── manager.stopTunnel(tunnelId)  ◀────┘
       │
       │  subscribe(mode="detached")
       │  or remote-management start
       ▼
   DETACHED  (session disconnect has no effect)
       │
       │  /tunnels/stop or daemon shutdown
       ▼
   (removed)
```

Key invariants:

- Foreground tunnels die 5 seconds after their WS session disconnects if nobody re-attaches. Implemented as `startGraceTimer` → `killOrphanedTunnel` in `SessionTracker`.
- Detached tunnels are immune to session disconnect and persist in `daemon-state.json` for crash recovery.
- `attach(tunnelId, sessionId, mode)` cancels any pending grace timer for that tunnel.
- `pinggy attach <name|id>` opens a fresh foreground subscription; if the tunnel was in detached mode, the call still succeeds, the timer is not armed (mode stays foreground while subscribed).

## 8. Crash recovery

`src/daemon/stateStore.ts` writes `daemon-state.json` after every tunnel start/stop. The schema:

```ts
interface DaemonState {
  tunnels: DaemonStateTunnel[];   // {tunnelId, configId, name, origin, config, mode, startedAt}
  lastUpdated: string;
}
```

Two lifecycle paths:

- **Clean shutdown** (`/shutdown` or signal): `clearDaemonState()` deletes the file. Next daemon start sees nothing to recover.
- **Crash** (SIGKILL, OOM, panic): the file remains. Next daemon start calls `restoreCrashedTunnels()`, which restarts each `mode === "detached"` tunnel using the persisted config and stable `tunnelId` (so log files stay continuous). Foreground tunnels are not restored: there is no CLI to attach.

Auto-start tunnels are independent of crash recovery. They come from saved configs marked `autoStart: true` (`getAutoStartConfigs()`), not from the state file.

## 9. Tunnel lifecycle end-to-end

Foreground start (`pinggy start <name>`):

```
 CLI: pinggy start my-tunnel
   │
   ▼
 subcommands.handleStart()
   ├─ resolveConfig("my-tunnel") → SavedTunnelConfig
   ├─ buildFinalConfig() with optional flag overrides
   └─ startForegroundViaDaemon(finalConfig)
        │
        ▼
   initClient() → new TunnelClient() → ensureDaemon()
        │  (spawns daemon if missing)
        ▼
   client.handleStartV2(finalConfig)            ── HTTP POST /tunnels/start-config
        │                                                 │
        │                                                 ▼
        │                                         IPCServer.handleStartV2
        │                                                 │
        │                                                 ▼
        │                                         TunnelManager.createTunnel + startTunnel
        │                                                 │
        │                                                 ▼
        │                                         attachTunnelLogger(tid, origin, name)
        │                                                 │
        │                                                 ▼
        │                                         SDK opens tunnel, returns urls
        │  TunnelResponseV2 ◀───────────────────── 200 OK
        ▼
   client.attach(tunnelId, "foreground")       ── WS subscribe
        │
        ▼
   connectTui()
        ├─ TTY available + !noTui  → blessed TUI
        └─ else                    → plain stdout
        │
        ▼
   await TUI exit / SIGINT
        │
        ▼
   client.handleStop(tunnelId)                  ── HTTP POST /tunnels/stop
   client.close()                               ── WS close
```

Background start adds `-b` flag → `startBackgroundTunnels()`. The CLI exits immediately after the daemon confirms start; the tunnel keeps running.

Attach (`pinggy attach <name|id>`):

```
 attachCommand.handleAttach()
   ├─ ensureDaemon()
   ├─ client.handleListV2()
   ├─ findTunnel(list, nameOrId)            (id exact, id prefix, name, configId)
   ├─ client.attach(tunnelId, "foreground")  (cancels detached grace timer? no, only foreground grace)
   └─ connectTui()
```

The first time a detached tunnel is attached, the SessionTracker entry flips to `foreground` while the WS session is open. When the TUI quits, the user can choose to stop the tunnel (default in `connectTui`'s `onExit`).

## 10. Components by directory

```
src/
├── main.ts                       Entry dispatch (daemon-child / subcommand / legacy)
├── index.ts                      Library exports for embedding in Electron
├── types.ts                      Shared types: TunnelStatus, FinalConfig, ErrorResponse, enums
├── logger.ts, logger/            Winston root + per-tunnel transport attach/detach
│
├── cli/                          Foreground CLI surface
│   ├── subcommands.ts            Router for `config|start|stop|ps|attach|daemon|logs|log|restart`
│   ├── startCli.ts               Foreground/background/multi/auto-start orchestration
│   ├── buildAndStartTunnel.ts    Legacy single-tunnel path
│   ├── buildConfig.ts            CLI flags + positionals → FinalConfig
│   ├── configStore.ts            Persisted saved-config CRUD
│   ├── daemonCommands.ts         `pinggy daemon start|stop|status|install-service|...`
│   ├── attachCommand.ts          `pinggy attach`
│   ├── psCommand.ts              `pinggy ps`
│   ├── stopCommand.ts            `pinggy stop`
│   ├── restartCommand.ts         `pinggy restart`
│   ├── logCommand.ts, logsCommand.ts  `pinggy log`, `pinggy logs`
│   ├── options.ts, extendedOptions.ts, defaults.ts, help.ts
│
├── daemon/                       Daemon process + IPC
│   ├── daemonChild.ts            runDaemonChild() entry. Persistence, recovery, auto-start.
│   ├── daemonManager.ts          getDaemonInfo, startDaemon, stopDaemon (spawn/discovery)
│   ├── ipcServer.ts              HTTP + WS endpoints. Owns Routes map + WS sessions.
│   ├── ipcClient.ts              Raw HTTP wrapper (no WS). Internal to tunnelClient.ts only.
│   ├── tunnelClient.ts           PUBLIC facade. TunnelClient + DaemonTunnelHandler.
│   ├── wsProtocol.ts             ClientMessage, TunnelEvent, TunnelEventPayloadMap.
│   ├── sessionTracker.ts         Foreground/detached ownership + grace timer.
│   ├── stateStore.ts             daemon-state.json read/write/clear.
│   └── serviceInstaller.ts       systemd / launchd / Task Scheduler installers.
│
├── tunnel_manager/
│   └── TunnelManager.ts          Singleton wrapping @pinggy/pinggy SDK. Listener fanout.
│
├── remote_management/            Remote control via Pinggy management WS
│   ├── remoteManagement.ts       Connect/disconnect + state machine
│   ├── handler.ts                TunnelHandler interface + TunnelOperations impl
│   ├── remote_schema.ts          Zod schemas for V1 + V2 payloads
│   ├── websocket_handlers.ts, websocket_printer.ts
│
├── tui/                          Foreground UI
│   ├── blessed/                  blessed-based TUI for tunnels
│   ├── ink/                      React/Ink prototypes
│   └── spinner/                  Loading spinner widget
│
├── utils/                        Cross-cutting helpers
│   ├── configDir.ts              Per-OS config + log paths
│   ├── parseArgs.ts              CLI arg parser
│   ├── printer.ts                CLIPrinter singleton
│   ├── getFreePort.ts            Free local port for web debugger
│   ├── FileServer.ts             Static file serving
│   └── htmlTemplates.ts          Built-in error pages
│
└── workers/
    └── file_serve_worker.ts      Worker thread for --serve
```

## 11. Key types

- `TunnelOrigin = "app" | "cli" | "remote"` (`src/tunnel_manager/TunnelManager.ts`). Set on every tunnel at creation; flows into log filenames.
- `ClientOrigin = "app" | "cli" | "remote"` (`src/daemon/ipcClient.ts`). Same values, used in the `X-Pinggy-Origin` header.
- `TunnelStateType` (`src/types.ts`): `idle | starting | running | live | closed | exited`.
- `FinalConfig` (`src/types.ts`): the SDK's `TunnelConfigurationV1` plus `conf?` and `saveconf?`. Used by `buildConfig.ts` and threaded through to the daemon.
- `TunnelResponseV2` (`src/remote_management/handler.ts`): `{tunnelid, remoteurls, tunnelconfig, status, stats, greetmsg?}`. The canonical wire shape.
- `DaemonInfo` (`src/daemon/daemonChild.ts`): `{pid, port, startedAt}`. The contents of `daemon.json`.
- `DaemonStateTunnel` (`src/daemon/stateStore.ts`): `{tunnelId, configId, name, origin, config, mode, startedAt}`. Crash recovery row.

## 12. Singletons and listener maps

The daemon process holds these singletons:

- `TunnelManager.getInstance()`. Wraps the SDK. Holds `Map<tunnelId, ManagedTunnel>`. All tunnel state lives here.
- `logger` (winston). Global root logger. Per-tunnel `File` transports are added/removed by `attachTunnelLogger` / `detachTunnelLogger` in `src/logger/tunnelLogger.ts`, gated by `isTunnelLoggingEnabled()`.
- `CLIPrinter`. Only used by CLI process for foreground output. Daemon does not print to stdout.

Listener registration pattern (used by TunnelManager and propagated by IPCServer):

```ts
Map<tunnelId, Map<listenerId, (...) => void>>
```

Register returns a `listenerId`; deregister takes it back. The IPCServer remembers `${type}:${listenerId}` strings in `session.listenerIds.get(tunnelId)` so a session can deregister everything cleanly on close.

## 13. Origin tagging and log file naming

When a tunnel is created, the IPCServer reads the `X-Pinggy-Origin` header and passes it to `TunnelManager.createTunnel(config, origin)`. The origin is stored on `ManagedTunnel.origin` and is used by `getTunnelLogPath(tunnelId, origin, name)`:

```
<origin>__<name>__<tunnelId>.log     when name present
<origin>__<tunnelId>.log             when nameless
```

Example: `cli__my-api__abc123.log`, `app__1700000000_xyz789.log`, `remote__staging__def456.log`.

This is how a shared daemon distinguishes tunnels from different clients on disk. The log viewers in the desktop app filter by the origin prefix.

## 14. Logging architecture

Three log artifacts:

| Log             | Writer                                | Path                                                  | Lifetime                      |
| --------------- | ------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| Application log | Electron host via `electron-log`    | `<userData>/logs/`                                  | Persistent, rolled            |
| Daemon log      | winston root inside daemon            | `<logDir>/daemon.log`                               | Persistent, rolled            |
| Tunnel log      | winston `File` transport per tunnel | `<logDir>/tunnels/<origin>__<name>__<tunnelId>.log` | While tunnel runs (10MB × 3) |

Toggle: `setTunnelLoggingEnabled(false)` detaches every per-tunnel transport immediately. Tunnels keep running; nothing else changes. Re-enabling does not retroactively re-attach to running tunnels (transports are recreated on next tunnel start).

CLI logs (the short-lived foreground process) go to stdout by default. The daemon log captures everything inside the long-running process.

## 15. Remote management integration

`src/remote_management/remoteManagement.ts` opens a WebSocket to Pinggy's management endpoint and forwards tunnel commands. The receiver implements `TunnelHandler`. Two implementations exist:

- `TunnelOperations` (`src/remote_management/handler.ts`). Direct, in-process. Used when remote management runs **inside the daemon** (not the default in CLI).
- `DaemonTunnelHandler` (`src/daemon/tunnelClient.ts`). Proxy. Forwards every `handleStart`, `handleStop`, etc. over HTTP to the daemon. Used when remote management runs **inside the CLI process** (the current default).

`TunnelClient.forRemoteManagement()` returns a `DaemonTunnelHandler` with `origin = "remote"`, so tunnels created via remote management are tagged distinctly and logged separately.

Same code path as user-typed subcommands: the daemon does not know or care that the request came from remote management.

## 16. Service installation

`pinggy daemon install-service` writes a platform-specific service file and enables it:

- Linux: systemd user unit at `~/.config/systemd/user/pinggy.service`. `Type=simple`, runs `<binary> --_daemon-child` directly (no fork). `systemctl --user enable --now`.
- macOS: launchd `LaunchAgent` at `~/Library/LaunchAgents/io.pinggy.agent.plist`. `launchctl load`.
- Windows: Task Scheduler entry.

The installer resolves the binary via `resolveBinary()` in `src/daemon/serviceInstaller.ts`. Prefers `process.execPath` when running as a pkg binary, falls back to `which pinggy`, then to `node <script>`.

A system service gives restart-on-failure and start-at-login. The plain daemon mode does not.

## 17. Reference for AI agents

When making changes, these are the load-bearing files and the contracts that matter.

**Entry points**

- `src/main.ts` — argv dispatch. Adding a new top-level subcommand means updating `SUBCOMMANDS` in `src/cli/subcommands.ts` AND adding a handler. Updating the dispatch in `main.ts` is rarely needed.
- `src/daemon/daemonChild.ts` — daemon process entry. Anything that needs to run **once** when the daemon boots goes here.

**Adding a new IPC route**

1. Add the route key + handler in `IPCServer.registerRoutes()` (`src/daemon/ipcServer.ts`).
2. Add the wire method to `IPCClient` (`src/daemon/ipcClient.ts`).
3. Expose it on `TunnelClient` (`src/daemon/tunnelClient.ts`) — never let callers reach `IPCClient` directly.
4. If it streams events, add the event type to `DaemonEventType` and payload to `TunnelEventPayloadMap` in `src/daemon/wsProtocol.ts`, register the listener in `handleSubscribe`, deregister in `deregisterListeners`, dispatch in `TunnelClient.handleWsMessage`.

**Adding a new tunnel state**

If new state needs to survive a daemon crash, extend `DaemonStateTunnel` in `src/daemon/stateStore.ts` and update `restoreCrashedTunnels()` in `daemonChild.ts`. If it is only needed in memory, put it on `ManagedTunnel` in `src/tunnel_manager/TunnelManager.ts`.

**Foreground vs detached**

If you spawn a tunnel and want it to die when the CLI quits, subscribe with `mode: "foreground"`. If it should outlive the CLI, use `mode: "detached"` (and the daemon will write it to `daemon-state.json` for crash recovery).

**Origin**

Every tunnel must have a correct origin. The default in `parseOrigin()` is `cli`. If you add a new client surface, plumb a new origin value through `TunnelOrigin` and `ClientOrigin`. Origin affects log filenames; renaming an origin is a breaking change for log viewers.

**Singletons in tests**

`TunnelManager.instance = undefined` between tests, plus `jest.clearAllMocks()`. See `src/_tests_/` for examples. Use `@jest/globals` imports — there is no global `jest`.

**English style**

No em-dashes. Short phrases. Present tense. See `CLAUDE.md` § "English Style" before writing user-facing strings, error messages, or docs.

**Gotchas**

- Do not log to stdout from the daemon. The daemon's stdio is closed by `spawn({stdio: "ignore"})` on most platforms; writes will silently fail or fill an OS buffer.
- Do not call `process.exit()` inside daemon route handlers. The shutdown route is the only path that should terminate the process, and it does so via `setTimeout(() => process.exit(0), 200)` so the HTTP response can flush first.
- Do not import from `src/daemon/ipcClient.ts` outside `src/daemon/`. Use `TunnelClient` from `tunnelClient.ts`.
- The first CLI run on a fresh install will spawn the daemon and pay an 8-second worst-case latency. Subsequent runs reuse the daemon.
- `daemon.json` writes are atomic (write tmp, rename). Direct partial reads should not happen, but `getDaemonInfo()` still tolerates malformed JSON by returning `null` and triggering a respawn.
- The IPC server only listens on `127.0.0.1`. Do not change to `0.0.0.0` without adding authentication. The current design assumes loopback isolation.

## 18. Quick diagrams

### Start sequence (foreground, daemon already running)

```
   user            CLI                Daemon              SDK / TunnelManager
    │   pinggy start api   │                                       │
    ├──────────────────────▶                                       │
    │                      │ GET /ping (sanity)                    │
    │                      ├───────────────▶                       │
    │                      │ ◀───────────── │ {status:"ok"}        │
    │                      │ POST /tunnels/start-config            │
    │                      ├───────────────▶│ createTunnel + start │
    │                      │                ├──────────────────────▶
    │                      │                │ urls                  │
    │                      │                ◀──────────────────────┤
    │                      │ 200 TunnelResponseV2                  │
    │                      │ ◀──────────────│                      │
    │                      │ ws connect → /ws                      │
    │                      │ ws subscribe(tid, "foreground")       │
    │                      ├───────────────▶│ register N listeners │
    │                      │ tunnel_event "subscribed"             │
    │                      │ ◀──────────────│                      │
    │   TUI render         │                │                      │
    │ ◀────────────────────│                │                      │
    │                      │ tunnel_event "stats" (repeated)       │
    │                      │ ◀──────────────│                      │
    │   Ctrl+C             │                                       │
    ├──────────────────────▶ POST /tunnels/stop                    │
    │                      ├───────────────▶│ stopTunnel           │
    │                      │ ◀──────────────│                      │
    │                      │ ws close                              │
```

### Crash and recovery

```
                              ┌──────────────────────────────────┐
                              │  Daemon running, 2 detached      │
                              │  daemon-state.json: [t1, t2]     │
                              └──────────────────────────────────┘
                                            │  SIGKILL / OOM
                                            ▼
                              ┌──────────────────────────────────┐
                              │  Process gone, but state file    │
                              │  still on disk                   │
                              └──────────────────────────────────┘
                                            │  next pinggy command
                                            ▼
   getDaemonInfo() returns null (PID dead) ──▶ unlinks daemon.json
                                            │
                                            ▼
   startDaemon() spawns new child
                                            │
                                            ▼
   runDaemonChild()
     ├─ writeDaemonInfo()
     ├─ restoreCrashedTunnels()  ──▶ TunnelManager.createTunnel + startTunnel for t1, t2
     │                                using same tunnelid (log continuity)
     ├─ getAutoStartConfigs() ──▶ starts auto-start tunnels
     └─ "Daemon ready"
```

### Two clients, one daemon

```
        Time
         │
         │  10:00  Electron app launches.
         │         App finds no daemon → spawns. Daemon starts.
         │         App opens tunnel "web" with origin=app.
         │         log: app__web__t1.log
         │
         │  10:05  User runs `pinggy ps` from terminal.
         │         CLI finds daemon.json → connects (no spawn).
         │         Both tunnels (including the App's) appear in ps.
         │
         │  10:06  User runs `pinggy start api`.
         │         Origin=cli. Foreground TUI opens.
         │         log: cli__api__t2.log
         │
         │  10:10  User Ctrl+C's the CLI tunnel.
         │         CLI sends /tunnels/stop. Daemon stops t2.
         │         Daemon keeps running. App's tunnel t1 unaffected.
         │
         │  10:30  User closes Electron app.
         │         App calls /shutdown? No — App leaves the daemon up
         │         since CLI/remote may still use it.
         │         Daemon keeps running with t1 still live.
         ▼
```
