x# Pinggy CLI Architecture

Reference for developers and AI agents working on the `@pinggy/cli` codebase. Covers the two-process daemon model, IPC, state, session ownership, and module layout introduced on the `feat/daemon` branch.

For domain language (Tunnel, Daemon, Client, Origin, Foreground mode, etc.) see `CONTEXT.md`. For project rules and English style see `CLAUDE.md`. This file documents how the pieces fit together.

## 1. The two-process model

The `pinggy` binary has three execution modes, dispatched in `src/main.ts`:

| Mode                 | Trigger                          | Entry                                                           | Purpose                                                                                                                     |
| -------------------- | -------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Daemon child         | `--_daemon-child` flag         | `runDaemonChild()` in `src/daemon/daemonChild.ts`           | Long-running background process. Owns the `TunnelManager` and the SDK.                                                    |
| Subcommand           | First arg in `SUBCOMMANDS` set | `handleSubcommand()` in `src/cli/subcommands.ts`            | Short-lived CLI invocation:`config`, `start`, `stop`, `ps`, `attach`, `daemon`, `logs`, `log`, `restart`, `device`, and `devices`, which prints the new spelling. |
| Legacy single-tunnel | No subcommand, has flags         | `buildAndStartTunnel()` in `src/cli/buildAndStartTunnel.ts` | Backwards-compatible single-shot tunnel for flags like `-l 3000` or `-R0:...`.                                          |

The CLI never opens an SDK tunnel itself. Every tunnel is created inside the daemon. CLI processes talk to the daemon over HTTP + WebSocket on `127.0.0.1`.

`pinggy device` is the exception. In the foreground it runs the device agent inside the CLI process and talks to the dashboard directly. With `-b` (slice 17) the daemon runs the same agent instead, so it outlives the terminal. It reads the daemon's tunnel list, and since slice 10 it stops, restarts and starts tunnels when the dashboard asks. See section 17.

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
├── daemon-state.json            Active tunnels and the background device agent, for crash recovery
├── device.json                  Device agent identity + token, mode 0600
└── tunnels/
    └── <name>_<configId>.json   Saved tunnel configs (from `pinggy config save`)

<logDir>/
├── daemon.log                   Daemon process log (rolled)
└── tunnels/
    └── <origin>__<name>__<tunnelId>.log   Per-tunnel logs (rolled 10MB×3)
```

Helpers live in `src/utils/configDir.ts`: `getDaemonInfoPath`, `getDaemonLogPath`, `getTunnelLogPath`, `getTunnelConfigDir`, `getDeviceConfigPath`.

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
| GET    | `/device`                                                 | The background device agent's status (slice 17) |
| POST   | `/device/start`                                           | Start the device agent on `device.json`         |
| POST   | `/device/stop`                                            | Stop the device agent                           |

Conventions:

- The 3 `/device` routes read no request field. The agent's token and server come from `device.json`, never from IPC: any local user can reach this port, and a route that took a token would let another user point this user's shell at their own account. `DeviceAgentStatus` never carries the token. See section 17, Background mode.

- Every request sets `X-Pinggy-Origin: app|cli|remote|device` (defaulted in `parseOrigin()` to `cli`). Stored on the tunnel and used in log filenames.
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
  deviceAgent?: { startedAt: string; startedBy: TunnelOrigin };   // slice 17, absent when none runs
  lastUpdated: string;
}
```

Two lifecycle paths:

- **Clean shutdown** (`/shutdown` or signal): `clearDaemonState()` deletes the file. Next daemon start sees nothing to recover. The device agent host closes first, so no later write brings the file back.
- **Crash** (SIGKILL, OOM, panic): the file remains. Next daemon start calls `restoreCrashedTunnels()`, which restarts each `mode === "detached"` tunnel using the persisted config and stable `tunnelId` (so log files stay continuous). Foreground tunnels are not restored: there is no CLI to attach. Then, after the auto-start tunnels, `restoreCrashedDeviceAgent()` starts the device agent again when `deviceAgent` is set. Its token and server come from `device.json`. An older daemon reading the file ignores the field.

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
├── devices/                      Device agent for `pinggy device` (CLI process, reads the daemon)
│   ├── deviceAgent.ts            Connect loop, frame dispatch, heartbeat timer
│   ├── deviceIdentity.ts         device.json read/write/clear, token masking
│   ├── envelope.ts               Versioned frame wrapper + channel/op constants
│   ├── device_schema.ts          Zod schemas for welcome, error, disconnect payloads
│   ├── tunnels/tunnelList.ts     device/tunnels: daemon poll, whitelist, change detection
│   ├── tunnels/tunnelActions.ts  tunnel/start, stop, restart (slice 10), update (10b) against the daemon
│   └── login/                    `pinggy device login` (slices 12, 13): email sign-in over HTTPS, then the agent
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

- `TunnelOrigin = "app" | "cli" | "remote" | "device"` (`src/tunnel_manager/TunnelManager.ts`). `device` is the device agent acting for the dashboard's device page (slice 10). Set on every tunnel at creation; flows into log filenames.
- `ClientOrigin = "app" | "cli" | "remote" | "device"` (`src/daemon/ipcClient.ts`). Same values, used in the `X-Pinggy-Origin` header.
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

## 17. Device agent (`pinggy device`)

The one long-lived surface that is not a tunnel. `pinggy device connect` enrols the machine with the Pinggy dashboard and holds 1 WebSocket open so the dashboard can show it as online. In the foreground it runs in the CLI process. With `-b` the daemon runs it (slice 17, Background mode below). Code lives in `src/devices/`, entered from `src/cli/subcommand/handlers/deviceCommand.ts`.

**Email sign-in (slice 12).** `pinggy device login` gets the device token without the dashboard: it asks for an email, `POST /backend/api/v1/device-agent/login/start` emails a 6-digit code, and the code prompt races a `poll` every few seconds under 1 `AbortController`. A right code (and the TOTP, with MFA on) answers the token once. Since slice 13 the email also carries an Approve link: the CLI prints the `match_code` its page shows, a poll collects a link's approval, and a typed code answered `pending` stops the prompt so the poll can. The CLI writes `device.json`, prints the device's browser link and its QR code (`createQrCodes`, shared with the TUI): a one-time sign-in link after a typed code, the plain device page after the emailed link. Then it runs the same agent. Code in `src/devices/login/`: `deviceLogin.ts` (the command; every dependency injected, so `src/_tests_/deviceLogin.test.ts` runs it with no dashboard or terminal), `loginApi.ts` (`fetch`, `buildDashboardHttpUrl`, the public client token), `login_schema.ts` (zod), `prompts.ts` (`readline/promises`, 1 interface per question, closed on answer or abort; `askHidden` reads the authenticator code without showing it, since the code still works after it is typed and the open link asks for one). A stdin that is not a TTY stops at once and points at `connect --token`. The token is never printed.

**Install scripts (slice 14).** `scripts/install/install.sh` (macOS, Linux, POSIX `sh`) and `scripts/install/install.ps1` (Windows PowerShell 5.1 and 7) install or update the binary, put `pinggy` on PATH with no sudo, then run `pinggy device login` by full path. `install.sh` writes `~/.pinggy/bin/pinggy` and links `~/.local/bin/pinggy` to it, adding 1 marked block to the shell's rc file when `~/.local/bin` is not on PATH. `install.ps1` writes `%LOCALAPPDATA%\Pinggy\bin\pinggy.exe` and adds that directory to the user PATH. Both read 3 things this repo owns: the release asset names, the `Pinggy CLI version: <x.y.z>` line, and the `device login --manage` flag. A change to any of them changes both scripts in the same commit. `.github/workflows/website-cli-download-links-pr.yml` copies both, read at the release tag, to the website's `static/`, so pinggy.io serves `/install.sh` and `/install.ps1`. Lint with `shellcheck -s sh` and `PSScriptAnalyzer`. The step order is in `install-script-plan.md` under the backend's `docs/pinggy-devices/`.

**The token command (slice 16).** The dashboard shows `curl -fsSL https://pinggy.io/install.sh | DEVICE_AGENT_TOKEN=<token> sh`, and `$env:DEVICE_AGENT_TOKEN='<token>'; irm https://pinggy.io/install.ps1 | iex` on Windows. With the variable set, both scripts update an older binary without asking, then run `pinggy device connect` by full path, with `--manage` when `PINGGY_MANAGE` is set. The token reaches the CLI in its environment, never on a command line, where `ps` would show it. `install.sh` gives `connect` `/dev/null` as stdin, since it reads no key. `install.ps1` removes the variable in a `finally`, because `iex` runs in the user's own window. `handleDevice()` reads `DEVICE_AGENT_TOKEN` and deletes it from `process.env` before any verb runs, so no shell, daemon or other child inherits it (`takeEnvironmentToken()` in `deviceCommand.ts`). `connect` then picks the token from `--token`, else the variable, else `device.json`, and the server from `--manage`, else `dashboard.pinggy.io` for a token from the variable, else the server in `device.json` (`resolveConnectTarget()`). An empty variable counts as unset.

The design lives in the `pinggy_backend` repo under `docs/pinggy-devices/`: `cli.md` is the CLI contract, `api-websocket.md` the wire format, `slices/` the delivery order. This section records what the CLI implements today.

**In the foreground it runs in the CLI process.** The agent owns no tunnel. Since slice 09 it reads the daemon: `getDaemonInfo()` for `daemon.json`, then `IPCClient.listTunnels()` for `GET /tunnels`, every 5 s, and `listSavedConfigs()` for the saved configs. Listing never starts a daemon, and it refuses a daemon whose `ipcVersion` differs, as `ensureDaemonRunning()` does. Since slice 10 it also acts on the daemon when the dashboard asks (see Device tunnel actions below); only a start of a config may call `ensureDaemonRunning()`. `TunnelManager` and `TunnelClient` stay off this path. Killing the agent leaves running tunnels alone.

**It does not reuse `src/remote_management/`.** Remote management is a dashboard-driven tunnel controller keyed by an API key. A device is the machine itself, keyed by its own token, and the 2 sockets speak different protocols. The duplication is deliberate: the backend `constraints.md` lists the remote-management files as do-not-touch, and that loop keeps its fixed 5000 ms retry with no cap and no watchdog.

### Background mode (slice 17)

`pinggy device connect -b` and `pinggy device login -b` hand the agent to the daemon, as `pinggy start -b` hands it a tunnel, and exit once the device connects. `-b` is the existing `cliOptions.b`. Whoever hosts the daemon hosts the agent: the CLI's detached child, `pinggy daemon install-service`, or the Pinggy app, whose in-process daemon runs the same `runDaemonChild()`. The app reaches it through `TunnelClient.getDeviceAgentStatus()`, `startDeviceAgent()` and `stopDeviceAgent()`.

**The token never goes over IPC.** `device.json` is the hand-off: the CLI writes it, the daemon reads it. The 3 `/device` routes (section 5) read no request field. A target that differs from `device.json` (another token, or another server) is checked first in the CLI with `startDeviceAgent(..., { verifyOnly: true })`: 1 attempt, ended at `welcome`, which writes `device.json` as the foreground agent does. A token the dashboard refuses never reaches the file or the daemon.

`connect -b`, in `src/devices/backgroundAgent.ts`:

1. `takeEnvironmentToken()` and `resolveConnectTarget()`, as in the foreground.
2. A target that differs from `device.json`: the verify above. A refusal prints it and exits 1.
3. `ensureDaemonRunning()`.
4. `POST /device/start`. An older daemon answers 404, and the CLI says to stop it, or to update the Pinggy app when the app hosts it (`olderDaemonMessage()`).
5. `GET /device` every 500 ms for up to 15 s. `connected` prints the device, the email, the device link and the log path. `stopped` prints `lastError` and exits 1. Still connecting leaves it to the daemon and exits 0.

`login -b` signs in as the foreground does, then runs steps 3 to 5 in place of `runAgent`. `device stop` calls `POST /device/stop`. `device status` adds a `Background` line from `GET /device`. `device remove` stops a running background agent before it deletes `device.json`. A foreground `connect` or `login` refuses while `GET /device` reports a run: 2 agents on 1 credential refuse each other with `already_connected`.

**`DeviceAgentHost`** (`src/daemon/deviceAgentHost.ts`) holds at most 1 run, built in `runDaemonChild()` once the IPC port is known. `start(origin)` reads `device.json`: none answers `DEVICE_NOT_ENROLLED`, a run on the same token and server is left alone, and a run on another is stopped before the new one starts. Start and stop run 1 at a time through 1 promise chain. A run that ends on its own (401, revoked, deleted, replaced) keeps why in `lastError`. The host records the run in `daemon-state.json` through `trackDeviceAgentStart()` and `trackDeviceAgentStop()`; `close()` on shutdown records nothing.

The daemon's run differs from the foreground one in 3 dependencies, passed through `DeviceAgentOptions`:

- **Reporter.** The loop prints nothing itself. It calls a `DeviceAgentReporter` (`src/devices/deviceAgentReporter.ts`). The foreground's `printingReporter` prints the same lines as before. The daemon's logs to `daemon.log` and keeps the latest state for `GET /device`, without the email.
- **Its own port.** `selfTunnelListSource(port)` and `selfTunnelActionDependencies(port)` reach the daemon that runs the agent, never `daemon.json` and never `ensureDaemonRunning()`. From inside a daemon, that call would spawn a 2nd daemon, or host a 2nd one in the app's process, whenever `daemon.json` goes missing.
- **`writeIdentityWhileOwned()`.** The daemon's run rewrites `device.json` on `welcome` only while the file holds its own token. `connect -b` with a new token writes the new credential, then asks the daemon to switch; an old run that reconnects in between must not write the old one back.

| Event | The background agent |
| --- | --- |
| The CLI that ran `connect -b` exits, or its terminal closes | Keeps running. The daemon is detached |
| Daemon crash | Restored at the next daemon start (section 8) |
| `pinggy daemon stop`, or the Pinggy app quits | Stops. The socket closes with 1000 and every shell ends |
| Reboot | Stops, as a `-b` tunnel does |
| A terminal outcome | Stops, with `lastError`, and is removed from `daemon-state.json` |

**Inside the Pinggy app** `node-pty` resolves inside `app.asar`, where `spawn-helper` is not on real disk, and a spawn without its helper kills the process. `resolveNodePtyRoot()` copies the package out of an `.asar` archive the way it does out of a `pkg` snapshot, and `loadNodePty()` offers a terminal only when `hasExecutableSpawnHelper()` holds.

`IPC_VERSION` stays 1: the routes are additive, and a bump would make every installed app refuse a newer CLI daemon.

### Modules

| File | Holds |
| --- | --- |
| `src/devices/envelope.ts` | The versioned frame wrapper. `request()`, `event()`, `parseEnvelope()`, channel and op constants |
| `src/devices/device_schema.ts` | Zod schemas for `welcome`, error, and `disconnect` payloads. Types for `hello`, `heartbeat`, `device/info`, `device/metrics`, and `device/tunnels` |
| `src/devices/deviceIdentity.ts` | `device.json` read, write, clear, and token masking |
| `src/devices/deviceAgent.ts` | URL build, connect loop, frame dispatch, heartbeat and metrics timers. `startDeviceAgent()` returns a run with `stop()` and `done`; `runDeviceAgent()` is the foreground entry with the SIGINT handler |
| `src/devices/deviceAgentReporter.ts` | `DeviceAgentReporter`, the run's events. `printingReporter`: the foreground's terminal output. `printConnected()` |
| `src/devices/backgroundAgent.ts` | The CLI's half of `-b`: verify a new target, start the daemon's agent, wait for `connected`. `device stop`, the `status` line, the stop before `remove`, the foreground refusal |
| `src/daemon/deviceAgentHost.ts` | `DeviceAgentHost`: the daemon's 1 run, behind the `/device` routes. `writeIdentityWhileOwned()` |
| `src/devices/collectors/systemInfo.ts` | `collectSystemInfo()`: the `device/info` payload |
| `src/devices/collectors/metrics.ts` | `collectMetrics()`: the `device/metrics` payload, with `cpu_percent` from 2 samples |
| `src/devices/tunnels/tunnelList.ts` | `collectTunnelList()`: the `device/tunnels` payload, built from named fields of `GET /tunnels` and the saved configs. `startTunnelReporting()`: send at once, poll every 5 s, send only on change. `selfTunnelListSource(port)` for the daemon's own run |
| `src/devices/tunnels/tunnelActions.ts` | `handleTunnelAction()`: `tunnel/start`, `stop` and `restart` against the daemon, with the `device` origin, answered on the request's id and op. `selfTunnelActionDependencies(port)` for the daemon's own run |
| `src/devices/terminal/terminal_schema.ts` | Terminal ops, zod schemas for `open`, `close`, `ack`, `resize` and the `snapshot` request, `TerminalData`, `TerminalExit`, `TerminalHeld`, `TerminalContext`, `TerminalSnapshotPart`, refusal codes, grid clamp |
| `src/devices/terminal/terminalHandler.ts` | `TerminalHandler`: 1 per agent run, not per socket. `open` spawns and answers `opened`, output goes up as `data`, `ack` reopens the window, `close` kills, `resize` resizes, a shell exit sends `exit` then `close` up. `suspend`, `held`, `resumeAll` carry shells across a reconnect. While any shell is open, `pollShellContexts` reads the process table every 5 s and sends `context` on change, and `resumeAll` sends every shell's context again. `snapshot` answers a tab that attached with the shell's screen, in parts |
| `src/devices/terminal/screenMirror.ts` | `ScreenMirror`: 1 shell's screen, a headless xterm fed every bundle as it is sent, serialised on request. `isScreenMirrorSupported()`: both xterm packages load |
| `src/devices/terminal/flowWindow.ts` | `FlowWindow`: sent minus acked, in raw bytes, against the window from `welcome`. Closed means stop reading the pty |
| `src/devices/terminal/frameSplitter.ts` | `FrameSplitter`: bundles pty output into `data` frames at the raw cap derived from `max_frame_bytes`, or after `BUNDLE_MILLIS` |
| `src/devices/terminal/shellContext.ts` | Each shell's `cwd` and foreground program from the process table: `/proc` on Linux, `ps` and `lsof` on macOS, nothing on Windows. `programName()` keeps the first word, basename only, because a process can write its arguments into its own name. `ShellContextTracker` turns polls into `context` events, only on change |
| `src/devices/terminal/terminalRegistry.ts` | `TerminalRegistry`: terminal id to pty handle, with the per-device ceiling from `welcome` |
| `src/devices/terminal/ptySession.ts` | Lazy `node-pty` load, `isTerminalSupported()` (false unless `spawn-helper` can be exec'd), `spawnPty()`, the `spawn-helper` execute-bit repair, `signalForeground()` to the tty's foreground process group |
| `src/devices/terminal/nodePtyRuntime.ts` | `resolveNodePtyRoot()`: where `node-pty` loads from. Unpacks it onto real disk inside a `pkg` binary or an Electron `.asar` archive. `hasExecutableSpawnHelper()` |
| `src/devices/terminal/shellAllowlist.ts` | `resolveShell()`: exact match against `/etc/shells`, or `powershell.exe` and `cmd.exe` on Windows |
| `src/cli/subcommand/handlers/deviceCommand.ts` | The `login`, `connect`, `stop`, `status`, `remove` verbs, and `-b`. `refuseDevicesSpelling()` for the old spelling |
| `src/utils/helpMessages.ts` | `printDeviceHelp()` |

`Subcommand.Device` in `src/cli/configStore.ts` puts `device` in `SUBCOMMANDS` and `RESERVED_NAMES`, so no new saved tunnel config can be named `device`. `Subcommand.Devices` keeps the old spelling in both. `pinggy devices` prints `"pinggy devices" is now "pinggy device". Run: pinggy device <verb>` and exits 1. It names the verb only when it is 1 of the 5, else `--help`, and never repeats the other arguments, which can hold a token. Without it, `devices` would fall to legacy tunnel mode, where `--token` is the tunnel token, and a device token would reach the tunnel server.

### The envelope

Every frame, both directions:

```json
{"v": 1, "kind": "req|res|event", "ch": "system", "op": "hello",
 "id": "uuid on a req, empty on an event", "seq": 0, "ts": 1750000001, "payload": {}}
```

`ch` and `op` discriminate. `parseEnvelope()` returns `null` on anything unparseable instead of throwing, and an unknown `ch` or `op` is logged and ignored.

**Never close the socket over an unrecognised frame.** That single rule is what lets the dashboard ship a channel this build has never heard of, and what let the `terminal` channel arrive without a lockstep deploy. Any code path that throws on an unknown `ch` or `op` turns a forward-compatible protocol into one that needs lockstep deploys.

### Connect sequence

```
   agent                                                dashboard
     │ GET /backend/api/v1/device-agent/ws/connect            │
     │ X-Pinggy-Device-Token: <token>                         │
     ├───────────────────────────────────────────────────────▶│ 401 before the upgrade if the token is bad
     │ system/hello  {agent_version, os, hostname,            │
     │                capabilities: [tunnel, stats, terminal],│
     │                terminals: [shells still held]}         │
     ├───────────────────────────────────────────────────────▶│
     │ system/welcome {device_agent_id, accepted_proto,       │
     │                 heartbeat_interval_seconds, ...}       │
     │◀───────────────────────────────────────────────────────┤
     │ device.json written 0600                               │
     │ device/info {hostname, os, os_version, arch, ...}      │
     ├───────────────────────────────────────────────────────▶│ once
     │ device/metrics {cpu_percent, load_avg_*, memory_*}     │
     ├───────────────────────────────────────────────────────▶│ at once, then every stats_interval_seconds
     │ system/heartbeat {uptime_seconds}                      │
     ├───────────────────────────────────────────────────────▶│ every heartbeat_interval_seconds
```

The credential rides in `X-Pinggy-Device-Token`, not `Authorization`. The dashboard routes `Authorization: Bearer` by token length in `SecurityConfig`, and that path is off limits to this feature.

`welcome` answers `hello` whether or not the handshake succeeded. A refusal comes back on `welcome` too, with `{"error": {"code", "message"}}` as the payload, so the agent has exactly 1 branch to write.

On each `welcome` the agent prints "Connected as device <id>", then the owner's `email` and the device's `device_url` when `welcome` carries them (`printConnected()`). An older dashboard sends neither, and the agent prints only the id.

**Every cadence comes from `welcome`.** `heartbeat_interval_seconds` and `stats_interval_seconds` are server-assigned with no compiled-in fallback, so an operator retunes them without shipping a new agent. Add new ceilings there rather than inventing a second negotiation.

### Device info and metrics

After each `welcome` the agent sends `device/info` once, then starts `startMetricsReporting()`: 1 `device/metrics` frame at once, then 1 every `stats_interval_seconds`. Both timers stop when the socket settles, and a reading still sampling at that moment is dropped rather than sent late.

The collectors use Node's `os` module and nothing else. `systeminformation` and `node-os-utils` are out: a native addon may not load in the `node20` pkg binary. `node-pty` is the 1 exception, because nothing built in allocates a pty.

- `arch` is `os.machine()` (`x86_64`, `arm64`), not `os.arch()` (`x64`), so it matches `uname`.

### Device tunnels

After each `welcome` the agent also starts `startTunnelReporting()`: 1 `device/tunnels` frame at once, then a poll every 5 s that sends only when the list changed. Change detection compares the serialised list without `collected_at`; stats are not in the list, so traffic alone sends nothing. The poll stops when the socket settles, and a list still being read is dropped.

The list is a whitelist. Each tunnel row is built field by field: id, config id, name, state, error message (control characters dropped, 256 characters), public URLs, forwarding (`type` and `local_address`), mode, and 2 times. The token, basic auth, bearer tokens, header modifications, IP whitelist, server address, debugger address, `optional`, and stats stay on the machine. Saved configs send `config_id`, `name`, and `running` only. At most 50 tunnels and 100 saved configs, newest first, with `truncated`.

No daemon, or a dead pid in `daemon.json`, sends `daemon_running: false` with the saved configs still listed. A live daemon on another IPC version sends `daemon_unavailable_reason: "ipc_version_mismatch"` and is not asked; a live pid whose port does not answer sends `daemon_unreachable`.

### Device tunnel actions

`ch: "tunnel"` frames go to `handleTunnelAction()` (slice 10). The dashboard sends 4 requests, and the agent answers each on its `id` and op with `{tunnel_id, state}`, `{config_id}` for a rewritten saved config, or an error. The agent advertises `tunnel_control` in `hello` for start, stop and restart, `tunnel_update` for update (slice 10b), and `saved_config_update` for an update of a saved config; a dashboard refuses an op to an agent without its capability.

| Request | Daemon route | Starts a daemon |
| --- | --- | --- |
| `stop {tunnel_id}` | `POST /tunnels/stop` | no |
| `restart {tunnel_id}` | `POST /tunnels/restart`, `noWait` | no |
| `start {tunnel_id}` | `POST /tunnels/restart`, `noWait`. The daemon keeps a stopped tunnel, and restart starts it under the same id | no |
| `start {source: "device", config_id}` | `POST /tunnels/start-config`, `noWait`, detached, with the saved config whose `configId` is exactly `config_id` | yes |
| `start {source: "dashboard", config}` | `POST /tunnels/start-config`, `noWait`, detached, after `TunnelConfigV1Schema` and with null fields dropped | yes |
| `update {source: "dashboard", config}` | `GET /tunnels` to find the tunnel whose `configId` is exactly the config's, then `POST /tunnels/update-config-v2`, `noWait`. None found is `tunnel_not_found`, and the daemon is not asked | no |
| `update {source: "device", config_id, config}` | None. The saved config whose `configId` is exactly `config_id` is rewritten through `upsertConfig()`, after `TunnelConfigV1Schema`, keeping its id, `autoStart` and `uiMetadata`. A new name must pass `validateNameStrict()` (`invalid_payload`) and be free (`saved_config_name_taken`). A tunnel already running the config keeps what it runs | no |

A restart, and an update of a running tunnel, keep the tunnel in `GET /tunnels` as `starting` until the new instance replaces the old one, so the `pollNow()` after the answer finds it. A failed rebuild leaves it `exited`, with the reason in `errormsg`. A 2nd restart or update during the rebuild answers `TUNNEL_WITH_ID_OR_CONFIG_ID_ALREADY_RUNNING`, which the agent turns into `tunnel_action_failed`.

Every call goes through an `IPCClient` with origin `device`. With no daemon, a stop, restart or dashboard update answers `tunnel_not_found`. The daemon's `TUNNEL_WITH_ID_OR_CONFIG_ID_NOT_FOUND` becomes `tunnel_not_found`; any other refusal, and any throw, becomes `tunnel_action_failed` with the message cleaned and cut to 256. The dashboard config holds a token: no log line carries a config or a payload, only the op, the ids and the outcome code. After each action the agent calls `pollNow()` on the tunnel reporting, so the changed list reaches the page at once instead of on the next 5 s poll; a `pollNow()` during a read in flight reads again when it ends.
- `cpu_percent` samples `os.cpus()` twice, 200 ms apart, and differences the idle and total ticks. 1 reading is cumulative since boot and gives a flat, wrong number.
- `load_avg_1m`, `load_avg_5m`, `load_avg_15m` are `[0, 0, 0]` on Windows and are sent anyway, so the payload shape never varies by platform.
- `memory_used_bytes` is `totalmem - freemem`. On macOS that counts file cache as used.

The dashboard answers an unreadable payload with `invalid_payload` on the `device` channel. The agent ignores every non-`system` frame, so that answer is logged at debug and changes nothing.

### Terminal (slices T1, T1b, T2 and T3: open, close, shells that outlive the socket, output, input)

`ch: "terminal"` frames go to the run's `TerminalHandler`, never to `handleFrame()`. Output flows up as `data`, and keystrokes flow down as `data`.

```
   dashboard                                            agent
     │ terminal/open  req {terminal_id, cols, rows, shell, cwd}│
     ├───────────────────────────────────────────────────────▶│ allowlist, spawn
     │ terminal/opened res {terminal_id, pid, shell, cols, rows}
     │◀───────────────────────────────────────────────────────┤ same envelope id as the open
     │ terminal/data  event {terminal_id, data: base64}       │
     │◀───────────────────────────────────────────────────────┤ pty output, bundled
     │ terminal/ack   event {terminal_id, ack_seq, ack_bytes} │
     ├───────────────────────────────────────────────────────▶│ cumulative raw bytes drawn
     │ terminal/close event {terminal_id, reason}             │
     ├───────────────────────────────────────────────────────▶│ kill, send nothing back
     │ terminal/data  event {terminal_id, data: base64}       │
     ├───────────────────────────────────────────────────────▶│ keystrokes, written to the pty
     │ terminal/signal event {terminal_id, signal}            │
     ├───────────────────────────────────────────────────────▶│ INT, TERM, QUIT or HUP only
     │ terminal/resize event {terminal_id, cols, rows}        │
     ├───────────────────────────────────────────────────────▶│ the tabs watching it changed size
     │ terminal/exit  event {terminal_id, exit_code, signal}  │
     │ terminal/close event {terminal_id, user_closed}        │
     │◀───────────────────────────────────────────────────────┤ only when the shell exits on its own
     │ terminal/snapshot event {terminal_id, snapshot_id}     │
     ├───────────────────────────────────────────────────────▶│ a tab attached and asks for its screen (T6)
     │ terminal/snapshot event {part, last, after_seq, data}  │
     │◀───────────────────────────────────────────────────────┤ the screen, to that tab only
```

- **`terminal` is advertised only when `node-pty` loads.** `buildCapabilities(isTerminalSupported())`. The capability is what un-greys the Terminal button, so an agent must never advertise a shell it cannot spawn.
- **The dashboard validates neither shell nor cwd.** `resolveShell()` is the only check. A requested shell must equal an `/etc/shells` line exactly and exist; no request picks `$SHELL` when it is allowed. A missing cwd falls back to home rather than refusing.
- **A refusal answers on `opened`** with `{terminal_id, error: {code, message}}`: `invalid_payload`, `terminal_disabled`, `terminal_limit_reached`, `shell_not_allowed`, or `spawn_failed`.
- **A shell outlives the socket that opened it** (slice T1b). `runDeviceAgent()` builds 1 `TerminalHandler` for the whole run. When `connectOnce()` settles, `suspend()` pauses every pty (stops reading its master, so the shell blocks once the kernel buffer fills) and kills none. The next `hello` lists them in `terminals`. The dashboard answers `close` with `device_gone` for any it forgot, possibly before `welcome`, and `welcome` calls `resumeAll()`.
- **Only the agent stopping kills shells.** When the loop ends (interrupted, revoked, refused), `closeAll()` kills them. Killing the agent process reaps them too, through `SIGHUP` when the pty master closes.
- **A shell that exits while the socket is down sends nothing.** Its `close` has no socket to go to, and the next `hello` simply omits it. The dashboard records that as `device_gone`.
- **Output is read as raw bytes and sent as base64.** `spawnPty()` passes `encoding: null`, so a read that ends mid-character is not decoded into a replacement character. `FrameSplitter` sends a bundle at the raw cap from `rawBundleBytes(max_frame_bytes)` or after `BUNDLE_MILLIS`, whichever comes first. A frame above `max_frame_bytes` would close the socket, and every other terminal on it.
- **A full window stops the reads, not the sends.** `FlowWindow` counts raw bytes sent minus the browser's cumulative `ack_bytes`, clamped to what was sent. When it reaches the window, the handler pauses the pty and the shell blocks in the kernel. The next `ack` that reopens it resumes reads. Nothing is buffered on the agent.
- **Ctrl-C is input, not a signal.** It arrives as `data` byte `0x03`, and the pty's line discipline turns it into SIGINT for the foreground process group.
- **`signal` goes to the foreground process group**, never the shell's pid. `signalForeground()` reads the tty's `tpgid` with `ps` and calls `process.kill(-tpgid)`, falling back to the shell's own group. `node-pty`'s `kill(signal)` signals the pid only, and bash ignores SIGINT while `sleep` holds the terminal. The allowlist is `TERMINAL_SIGNALS`, enforced by the zod schema, so `KILL` and anything else never reach `kill`. Ignored on Windows.
- **`resize` touches the pty only on an actual change.** Every call is a `TIOCSWINSZ` and a SIGWINCH, and a full-screen program redraws on each.
- **2 things pause a pty, and neither lifts the other's.** A suspended handler (socket down) and a full window. `resumeAll()` skips a shell whose window is still full, and an `ack` does not resume a shell while the handler is suspended.
- **The window has no default.** `welcome.terminal_window_bytes` is the only place the number lives. Without it the handler answers every `open` with `terminal_disabled`.
- **`seq` counts per terminal from 1**, on every `data` frame, for the life of the shell rather than the socket. The dashboard closes a terminal with `sequence_gap` on a hole.
- **A bundle cut while the socket is down is held**, not sent into no socket. It takes no `seq` and does not count against the window until `resumeAll()` sends it first. It is at most what was already read when `suspend()` paused the pty.
- **The window still assumes 1 viewer.** T1b's multi-viewer rules for T2 (slowest viewer's ack, 10 s `too_slow` detach) are not built. Its replay for a late attach is T6's screen, below, not a buffer of bytes.
- **Every shell keeps its screen** (slice T6). `ScreenMirror` is a headless xterm (`@xterm/headless`, 1000 lines of scrollback) fed each bundle in `sendData`, in the same tick as its `seq`, never when the pty is read: a bundle still being cut would otherwise be in the screen and drawn twice. `snapshot` notes `after_seq` and `after_bytes`, then serialises inside the callback of an empty write queued on the mirror, which xterm runs before it parses anything fed later. The text goes out in parts of the raw bundle size. Parts take no `seq` and never count against the window. Over 1 MB it is serialised again with 200 lines, then with the screen alone, and past that it is not sent. The serialize addon needs `allowProposedApi`.
- **`terminal_snapshot` is advertised only beside `terminal`**, and only when both xterm packages load. The mirror is memory only, disposed with its shell, never logged and never written to disk.
- **No log line carries a payload.** Ids, pids, and codes only, and an error's class name rather than its message. Input is what a person typed, so it is never logged at any level.
- `welcome.terminal_enabled` and `welcome.max_terminals_per_device` are optional, so an older dashboard leaves the defaults (enabled, 3).

`node-pty` 1.1.0 publishes its macOS `spawn-helper` without the execute bit, and every spawn then fails with `posix_spawnp failed`. `ensureSpawnHelperExecutable()` restores it once, at load.

**A packaged binary loads `node-pty` from real disk, not from the snapshot.** `node-pty` does not exec the shell directly. It execs `spawn-helper`, at a path it derives from wherever its own module sits. Inside a `pkg` binary that path is `/snapshot/...`, which only exists in the `fs` module pkg patches, so the kernel cannot exec it and `posix_spawn` fails with `ENOENT`. The throw is fatal inside the addon, so no caller gets to answer for it.

`resolveNodePtyRoot()` copies the package out of the snapshot on first use and returns that path, so every path `node-pty` derives afterwards is a real one. It copies `package.json`, `lib/`, and this platform's native directory only: 41 files and 404 KB, against 62 MB for the whole package, most of which is other architectures' prebuilds. The copy lands in `~/.config/pinggy/runtime/node-pty-<version>-<platform>-<arch>`, staged under a sibling name and renamed into place, so 2 agents starting at once cannot load a half-written copy. An unpackaged run resolves through `require` as normal and copies nothing.

Not `pkg`'s own cache. `pkg` already unpacks the addon to `~/.cache/pkg/<hash>/` at mode 644, but the hash is undocumented and `node-pty` never looks there.

Measured on `macos-arm64` and `macos-x64`. `linux-x64`, `linux-arm64` and `win-x64` are unproven: that is T0 in the backend docs.

### Outcomes

`connectOnce()` resolves `"retry"` or `"terminal"`. The run's loop retries on the first and ends on the second. A terminal outcome ends the run with a `DeviceAgentError`: `unauthorized`, `handshake_refused`, the disconnect reason (`revoked`, `deleted`, `replaced`), or `disconnected` for any other. A verify run (`verifyOnly`) makes 1 attempt and ends with `not_connected` when it gets no `welcome`.

| Signal | Outcome |
| --- | --- |
| HTTP 401 on the upgrade | terminal |
| Close code 4001 | terminal |
| `welcome` with an error other than `already_connected` | terminal |
| `system/disconnect` with any reason but `shutdown` | terminal |
| `welcome` with `already_connected` | retry. A live node elsewhere holds the device. The dashboard closes with 4002, and the close handler schedules the retry |
| `system/disconnect` with `shutdown` | retry. The node is draining, the credential is fine |
| Any other close code, socket error, or unreadable `welcome` | retry |

Retry sleeps an exponential backoff with full jitter: 1 s doubling to a 60 s cap, drawn as `random(0, ceiling)`, reset to 1 s only after a connection holds 60 s. The schedule lives in `src/devices/reconnect.ts` as pure functions over an injected clock, so it is testable without a socket; `deviceAgent.ts` owns the timers.

2 timers catch a socket that died without saying so, since a dropped link sends nothing and leaves `readyState` at `OPEN`. A handshake timer gives the dashboard 30 s to answer `hello` with `welcome`. After `welcome` a pong watchdog pings every heartbeat interval and drops the socket after 2 unanswered. Both call `terminate()` rather than `close()`, because a polite close waits for a close frame from the peer that has already stopped answering. `ws` auto-answers inbound pings on its own, so the agent sends its own and does not handle theirs.

`stop()` ends a run at once: it cancels a backoff sleep, closes the live socket with 1000, drops it with `terminate()` after 3 s without the dashboard's close frame, and resolves when the loop has ended and every shell is closed. In the foreground, `runDeviceAgent()` calls it from a `process.once("SIGINT")` handler, and a second Ctrl+C hits Node's default handler and exits at once. `startDeviceAgent()` installs no signal handler: the daemon and the Pinggy app own their signals.

### `device.json`

```json
{"device_agent_id": "0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d", "token": "...",
 "server": "dashboard.pinggy.io", "enrolled_at": "2026-09-05T09:22:10Z"}
```

`getDeviceConfigPath()` puts it beside `tunnels/`, not inside it: a device is not a tunnel config. `device_agent_id` is minted by the dashboard and read from `welcome`; the agent never invents one. A token from `--token` or `DEVICE_AGENT_TOKEN` always beats the stored value. When it differs from the stored token, `identityForRun()` starts a new identity, with no old `device_agent_id` and no old `enrolled_at`, and the run reports "This machine was device <old id>. Connecting it with the token from the command." The old device stays in the dashboard, offline.

**Written 0600, then chmodded again on every rewrite**, because `writeFileSync` applies `mode` only when it creates the file. This diverges from `configStore.ts`, which writes tunnel tokens at 0644 under a normal umask. Do not copy that pattern into anything new.

`pinggy device remove` deletes this file and nothing else, after it stops a background agent. Revoking the device server-side is a dashboard action, because a machine that has lost its credential cannot authenticate the delete.

### Composition with other subcommands

`isSubcommand()` reads `rawArgs[0]` and nothing else. The first token picks the mode for the whole invocation, and there is no chaining: a second subcommand word is an ordinary argument to the first handler. `handleDevice` takes `args[0]` as its verb and passes the tail to `parseCliArgs(cliOptions, ...)`, which allows positionals, so leftover words are parsed and dropped.

| Command | Behaviour | Where it is decided |
| --- | --- | --- |
| `device connect start my-tunnel` | Runs the agent. `start` and `my-tunnel` land in `positionals` and are ignored | `deviceCommand.ts`, `parseCliArgs` with `allowPositionals: true` |
| `device start`, `device daemon stop` | `Unknown command "<verb>"`, `process.exit(1)` | The `default` arm of the verb switch |
| `device connect -l 3000 -b --all --remote-management KEY` | Runs the agent in the daemon, for `-b`, and ignores the other 3. Only `values.token`, `values.manage` and `values.b` are read. No tunnel and no remote management | `handleDevice` reads 3 fields off `values` |
| `device connect`, `device login` while the daemon runs an agent | Refused, exit 1: "This machine already runs as device <id> in the background. Stop it first: pinggy device stop" | `foregroundRefusal()` in `backgroundAgent.ts` |
| `device stop` with no background agent | "No device agent is running in the background.", exit 0. Never starts a daemon | `stopAgentInBackground()` |
| `device connect --typo` | `Fatal Error: Unknown option '--typo'`, exit 1, before dispatch | `main()` parses the full argv with `parseArgs` in strict mode, then calls `isSubcommand` |
| `device connect --help` | Ignores `--help` and connects. Only `device` and `device --help` reach `printDeviceHelp()` | The verb switch tests `--help` in its `default` arm only |
| `device --version` | Unknown verb error. `values.version` is handled after the subcommand branch returns | `main()` order |
| `start device`, `stop device`, `attach device` | `device` reads as a config or tunnel name and never matches, because `RESERVED_NAMES` blocks the name at save time. `stop` and `attach` still call `ensureDaemon()` first and spawn a daemon | `configStore.ts`, then each handler |
| `config save device ...` | Rejected by `validateNameStrict` | `configStore.ts` |
| `-l 3000 device` | Legacy tunnel mode. `device` fails `domainRegex` in `isValidServerAddress`, so it stays a positional and reaches `parseExtendedOptions`, which warns `Unknown extended option "device"`. The tunnel starts normally | `buildConfig.ts`, `extendedOptions.ts` |
| `--remote-management KEY device connect` | Legacy mode again, because `rawArgs[0]` is a flag. Remote management starts, `device` and `connect` each draw an unknown-extended-option warning, and no agent runs | `main()`, `extendedOptions.ts` |
| `device connect --_daemon-child` | Runs the daemon child. The internal flag is checked before `isSubcommand` | `main()` order |
| `devices`, with any verb or flag | The old spelling. Prints the new one, exit 1. Never reaches tunnel mode, so `--token` is never read as the tunnel token | `refuseDevicesSpelling()` in `deviceCommand.ts` |

2 of these are rough edges rather than decisions: `--help` after a verb is ignored, and extra positionals after a verb are dropped in silence. Both are 1-line fixes in `handleDevice` if the silence proves confusing.

### The agent and the daemon

In the foreground the agent shares no state with the daemon or with tunnels, which is what makes the composition table boring.

- `pinggy device connect` never calls `ensureDaemon()`, so it neither finds nor spawns one. A device agent on a machine with no daemon writes no `daemon.json`.
- `pinggy daemon stop` stops tunnels and the daemon. A foreground agent is a separate process and keeps going.
- Ctrl+C on the agent touches no tunnel. There is no `SessionTracker` entry, no grace timer, and no origin tag.
- The agent logs through `CLIPrinter` and the CLI logger, not the daemon log. Nothing about it reaches `daemon.log` or the per-tunnel logs.

With `-b` the daemon owns the agent: `ensureDaemonRunning()` may start a daemon, `pinggy daemon stop` stops the agent too and says so, the agent logs to `daemon.log`, and `daemon-state.json` records it. It still has no `SessionTracker` entry and no origin tag of its own.

1 identity per config dir, last write wins: a run keeps what `device.json` holds while the token matches, sets the server, and rewrites the file on every `welcome`. So `device remove` during a live foreground session deletes a file the agent restores on its next reconnect, and 2 agents sharing 1 credential lose the race by design: the dashboard refuses the second with `already_connected`, and it retries on the backoff until the first socket drops. The daemon's run rewrites the file only while it holds its own token (`writeIdentityWhileOwned()`).

### Not built yet

In this repo: terminal input, output, flow control, resize, and signals (T2, T3). A `pkg` build that
carries `node-pty` (T0). Slice 04's backoff and pong watchdog, slice 05's `device/info` and
`device/metrics` collectors, and T1's terminal open and close have all landed. Everything else
outstanding is dashboard or frontend work.

## 18. Reference for AI agents

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
- Every tunnel reconnects without limit. `_createTunnelWithProcessedConfig()` in `TunnelManager.ts` sets `maxReconnectAttempts` to 0 and ignores the value the caller sends. Create, restart and update all pass through it, so the rule covers the CLI, the app, autostart, crash recovery and remote management. libpinggy counts reconnects over the whole tunnel lifetime and does not reset the count after a successful reconnect. Any limit, including the libpinggy default of 20 for an omitted value, stops a long-running tunnel permanently.
- Do not route the foreground `pinggy device` through the daemon. With `-b` the daemon runs the agent, and no IPC route takes or returns a token or a server: the daemon reads both from `device.json`. Any local user can reach the IPC port.
- Do not generalise `src/remote_management/` to serve the device agent. Those files are on the backend `constraints.md` do-not-touch list.
- `device.json` holds a live credential. Any code that writes it goes through `writeDeviceIdentity()`, which keeps the 0600 mode on rewrites.

## 19. Quick diagrams

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
