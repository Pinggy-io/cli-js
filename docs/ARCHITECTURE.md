# Pinggy CLI Architecture
Reference for developers and AI agents working on the `@pinggy/cli` codebase. Covers the two-process daemon model, IPC, state, session ownership.

For domain language (Tunnel, Daemon, Client, Origin, Foreground mode, etc.) see `CONTEXT.md`. For project rules and English style see `CLAUDE.md`. This file documents how the pieces fit together.

## 1. The two-process model

The `pinggy` binary has three execution modes, dispatched in `src/main.ts`:

| Mode                 | Trigger                          | Entry                                                           | Purpose                                                                                                                     |
| -------------------- | -------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Daemon child         | `--_daemon-child` flag         | `runDaemonChild()` in `src/daemon/daemonChild.ts`           | Long-running background process. Owns the `TunnelManager` and the SDK.                                                    |
| Subcommand           | First arg in `SUBCOMMANDS` set | `handleSubcommand()` in `src/cli/subcommands.ts`            | Short-lived CLI invocation:`config`, `start`, `stop`, `ps`, `attach`, `daemon`, `logs`, `log`, `restart`. |
| Legacy single-tunnel | No subcommand, has flags         | `buildAndStartTunnel()` in `src/cli/buildAndStartTunnel.ts` | Backwards-compatible single-shot tunnel for flags like `-l 3000` or `-R0:...`.                                          |

## 2. Filesystem layout

State lives under `getPinggyConfigDir()` (`src/utils/configDir.ts`):

- Linux: `$XDG_CONFIG_HOME/pinggy` (default `~/.config/pinggy`)
- macOS: `~/.config/pinggy`
- Windows: `%APPDATA%/pinggy`

Logs live under `getPinggyLogDir()`:

- Linux: `$XDG_STATE_HOME/pinggy-cli/logs`
- macOS: `~/Library/Logs/Pinggy-CLI`
- Windows: `%LOCALAPPDATA%/Pinggy-CLI/Logs`

## 3. Daemon discovery and spawn

Every CLI invocation that touches a tunnel asks one question first: is there a live daemon to talk to? `getDaemonInfo()` answers it by reading `daemon.json` and validating the recorded PID with `process.kill(pid, 0)`. Signal 0 never delivers anything; it just throws when the target process is gone, which is exactly the liveness probe we need. A missing file, malformed JSON, or a dead PID all collapse to the same result: return `null`, and let `ensureDaemonRunning()` spawn a fresh child.

The spawn path is deliberately one-way. The CLI fires off a detached child with the `--_daemon-child` flag and then polls `daemon.json` until the child writes it. The poll budget is 8 seconds at 200ms intervals; a timeout almost always means the SDK failed to load inside the child, in which case the stderr captured from the spawned process is surfaced in the thrown error. Atomic writes of `daemon.json` (write to `.tmp`, then `fs.renameSync`) keep concurrent readers from ever seeing a half-written file.

Implementation: `src/daemon/daemonManager.ts`. 

## 4. IPC: HTTP routes

HTTP carries every request/response operation: start, stop, list, restart, log management, shutdown. The transport is plain `http` on `127.0.0.1` with an OS-assigned port. Loopback isolation is the security boundary; there is no auth on these routes, so binding anywhere other than `127.0.0.1` is unsafe.

Server: `src/daemon/ipcServer.ts`. Client: `src/daemon/ipcClient.ts`. Public facade: `src/daemon/tunnelClient.ts`.

Conventions:

- Every request sets `X-Pinggy-Origin: app|cli` (defaulted in `parseOrigin()` to `cli`). Stored on the tunnel and used in log filenames.

- `start` is idempotent on `configId`. If a tunnel with the same `configId` is already running, the daemon returns `ErrorResponse{code: TunnelAlreadyRunningError}` and the CLI prints the existing state instead of starting a duplicate.
- A successful operation returns its typed response with HTTP 200. An expected application-level failure returns `ErrorResponse` JSON, still with HTTP 200; the route handled the request, the operation just failed. Non-200 means a transport-level problem (daemon died mid-request, port in use after spawn, etc.) and surfaces as a thrown error in `IPCClient`.
- The `mode` field (added to `start`, `start-config`, `start-v1`) tells `trackIPCTunnelStart` whether to persist the tunnel to `daemon-state.json`. Foreground tunnels are not persisted; detached tunnels are. The default is `"detached"`, which is what remote management and `DaemonTunnelHandler` rely on.

## 5. IPC: WebSocket event stream

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

## 7. Foreground vs detached: SessionTracker

`SessionTracker` in `src/daemon/sessionTracker.ts` tracks ownership of each running tunnel.

```
ownership: Map<tunnelId, { sessionId, mode: "foreground" | "detached" }>
graceTimers: Map<tunnelId, NodeJS.Timeout>
```
Key invariants:

- Foreground tunnels die 5 seconds after their WS session disconnects if nobody re-attaches. Implemented as `startGraceTimer` → `killOrphanedTunnel` in `SessionTracker`.
- Detached tunnels are immune to session disconnect and persist in `daemon-state.json` for crash recovery.
- `attach(tunnelId, sessionId, mode)` cancels any pending grace timer for that tunnel.
- `pinggy attach <name|id>` opens a fresh foreground subscription; if the tunnel was in detached mode, the call still succeeds, the timer is not armed (mode stays foreground while subscribed).

## 8. Origin tagging and log file naming

When a tunnel is created, the IPCServer reads the `X-Pinggy-Origin` header and passes it to `TunnelManager.createTunnel(config, origin)`. The origin is stored on `ManagedTunnel.origin` and is used by `getTunnelLogPath(tunnelId, origin, name)`:

```
<origin>__<name>.log     when name present
<origin>__<tunnelId>.log             when nameless
```

Example: `cli__my-api.log`, `app__1700000000_xyz789.log`.

This is how a shared daemon distinguishes tunnels from different clients on disk. The log viewers in the desktop app filter by the origin prefix.

## 9 Tunnel lifecycle end-to-end

see the flowchart in [TUNNEL_LIFECYCLE.md](TUNNEL_LIFECYCLE.md)