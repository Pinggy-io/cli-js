# Pinggy CLI

Create secure, shareable tunnels to your localhost and manage them from the command line.


## Key features
- HTTP, TCP, UDP, TLS, TLSTCP tunnels to localhost
- SSH-style and user-friendly flags
- Web debugger for HTTP tunnels
- Extended options for auth, header manipulation, IP allowlists, CORS handling, etc.
- Persistent background daemon owns every tunnel; CLI invocations are short-lived
- Foreground (live TUI) and detached (`-b`) tunnel modes
- Lifecycle commands: `ps`, `start`, `stop`, `restart`, `attach`
- Per-tunnel and per-daemon log files with `pinggy logs` (tail, follow, rotation-safe)
- System-service install for auto-start at boot (systemd, launchd, Task Scheduler)
- Remote management via secure WebSocket connection (works with Pinggy Dashboard)
- Save and load configuration files
- Config store for saving, listing, updating, and starting named tunnel configs
- Auto-start support for launching saved tunnels automatically
- Simple file server mode for quickly sharing local files
- Built-in TUI (Text User Interface) for viewing tunnel statistics, requests, and responses in real time


## Architecture at a glance
The CLI runs as two processes. A short-lived foreground process is what you invoke. A long-running daemon owns every tunnel and the `@pinggy/pinggy` SDK. They talk over HTTP and WebSocket on `127.0.0.1`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full breakdown of the two-process model, IPC routes, daemon discovery, session ownership, and filesystem layout.

## Requirements
- Node.js 18+ (recommended). The CLI uses modern ESM and WebSocket features.
- A network connection that allows outgoing WebSocket/HTTPS traffic.


## Installation
Global install is recommended for system-wide "pinggy" command.

- Using npm:
 ``` bash
  npm install -g pinggy
  ```

After install, verify:
```bash
  pinggy --help
```


## Quick start
- Start a basic HTTP tunnel to localhost:3000:

 ```bash
  pinggy -R0:localhost:3000
 ```

- Start a TCP tunnel (e.g., SSH on port 22):

```bash
  pinggy -R0:localhost:8000 tcp@free.pinggy.io
```

- Start HTTP tunnel with web debugger on 4300:
```bash
pinggy -R0:localhost:8000 -L4300:localhost:4300
```

- Use a token and region/domain-like arg:
  pinggy mytoken@a.example.com -p 3000. For more info read [docs](https://pinggy.io/docs/)

The CLI prints generated public URLs (HTTP/HTTPS or TCP) and keeps the TUI attached until you press Ctrl+C. Tunnels run inside a background daemon. See [Daemon](#daemon) and [Running tunnels](#running-tunnels) for `ps`, `stop`, and detached (`-b`) mode.

## Config management

The CLI includes a built-in config store for saving, listing, and starting tunnel configurations. Configs are persisted as JSON files under the platform config directory (see [State and file locations](#state-and-file-locations)).

Configs can be looked up by name (exact match) or by configId prefix (partial match) in every `config` and `start`/`stop`/`restart`/`attach` subcommand.

### Save a tunnel config
```bash
pinggy config save my-tunnel -l 3000 token@pro.pinggy.io
```

### Save with auto-start enabled
```bash
pinggy config save my-tunnel --auto -l 3000
```

### List all saved configs
```bash
pinggy config list
pinggy config ls          # alias for list
```

### View details of a saved config
```bash
pinggy config show my-tunnel
pinggy config show my-tunnel other-tunnel    # View multiple configs
pinggy config my-tunnel                      # Shorthand: same as `config show`
```

### Update a saved config
```bash
pinggy config update my-tunnel -l 4000
```

### Enable or disable auto-start
```bash
pinggy config auto my-tunnel
pinggy config noauto my-tunnel
pinggy config auto tunnel1 tunnel2           # Multiple configs at once
```

### Delete a saved config
```bash
pinggy config delete my-tunnel
pinggy config delete tunnel1 tunnel2         # Delete multiple
```


## Running tunnels

Every tunnel runs inside the daemon. The CLI either holds a live TUI subscription to it (foreground) or starts it and exits (detached).

### Foreground vs detached

- **Foreground** (default): `pinggy start <name>`. The CLI keeps a WebSocket open to the tunnel and renders the TUI. Use ctrl+C to close the TUI and stop the tunnel.
- **Detached** (`-b`): `pinggy start -b <name>`. The CLI prints the public URL, then exits. The tunnel persists in the daemon until you stop it explicitly with `pinggy stop`.

### Start a saved tunnel
```bash
pinggy start my-tunnel              # foreground, TUI attached
pinggy start -b my-tunnel           # detached, CLI exits immediately
```

### Start with runtime overrides
```bash
pinggy start my-tunnel -l 4000
```

### Start multiple tunnels
```bash
pinggy start tunnel1 tunnel2
```

> Runtime overrides (`-l`, `--type`, `--token`, ...) only apply when starting a single tunnel. For multiple tunnels, update the saved config first with `pinggy config update`.

### Start all auto-start tunnels
```bash
pinggy start --all
```
Runs through the daemon as detached tunnels. Useful for scripting and service startup.

### Start with remote management
```bash
pinggy start --all --remote-management <API_KEY>
pinggy start tunnel1 tunnel2 --remote-management <API_KEY>
```

### Start with logging enabled
```bash
pinggy start my-tunnel --vvv
pinggy start --all --logfile /tmp/pinggy.log --loglevel DEBUG
```

### List running tunnels
```bash
pinggy ps
```
Prints a table of ID, name, status, local endpoint, and public URL.

### Stop tunnels
```bash
pinggy stop my-tunnel
pinggy stop my-tunnel other-tunnel       # multiple
pinggy stop abc12345                     # by configId prefix
```

### Restart a tunnel
```bash
pinggy restart my-tunnel
```
Preserves the existing mode (foreground stays foreground, detached stays detached).

### Re-attach the TUI to a running tunnel
```bash
pinggy attach my-tunnel
```
Opens a fresh TUI session against a tunnel that is already running. Useful to inspect a detached tunnel live.


## Daemon

The daemon is the long-running process that owns every tunnel. The CLI starts it automatically when needed, so most users never call these commands directly. They exist for explicit control, scripting, and boot-time service install.

Both `pinggy daemon` and the alias `pinggy d` work.

### Start the daemon
```bash
pinggy daemon start
```
Lists which configs will auto-start (any tagged with `config auto`).

### Stop the daemon
```bash
pinggy daemon stop
```
Stops every running tunnel and shuts the daemon down cleanly.

### Show daemon status
```bash
pinggy daemon status
```
Prints PID, port, start time, and uptime.


## Remote management
You can control tunnels remotely using a secure WebSocket connection.

- Start remote management with a token:
```bash
 pinggy --remote-management <API KEY>
```

- Specify a management server (default is wss://dashboard.pinggy.io):
```bash
 pinggy --remote-management <API KEY> --manage wss://custom.example.com
```


## Usage
Basic syntax:
  pinggy [options] [user@domain]

- user@domain is optional. Domain can be any valid domain supported by the service backend (e.g., ap.example.com).

### Options
The CLI supports both SSH-style flags and more descriptive long flags. Below is a consolidated list (only public ones are shown here). For the most up-to-date help, run `pinggy --help`.

### **Port Forwarding**
| Flag | Description | Example |
|------|-------------|---------|
| `-R`, `--R` | Local port forwarding (SSH-style) | `-R0:localhost:3000` |
| `-L`, `--L` | Web debugger address (SSH-style) | `-L4300:localhost:4300` |

---

### **Connection**

| Flag | Description | Example |
|------|-------------|---------|
| `-p`, `--server-port` | Pinggy server port (default: 443) | `--server-port 8080` |
| `--type` | Type of connection (e.g., `tcp`) | `--type tcp` |
| `-l`, `--localport` | Local endpoint `[protocol:][host:]port` | `--localport https://localhost:8000` |
| `-d`, `--debugger` | Port for web debugger | `-d 4300` |
| `--token` | Token for authentication | `--token abc123` |
| `--force` | Forcefully close existing tunnels and establish a new tunnel | `--force` |

---

### **Logging**
| Flag | Description |
|------|-------------|
| `--loglevel` | Logging level: `ERROR`, `INFO`, `DEBUG` |
| `--logfile` | Path to log file |
| `--v` | Print logs to stdout |
| `--vv` | Detailed logs (Node.js SDK + Libpinggy) |
| `--vvv` | Enable logs from CLI, SDK, and Libpinggy |

These flags apply to the CLI invocation. For daemon-wide log level and per-tunnel log files, see [Logging](#logging).

---

### **Config (File-based)**
| Flag | Description |
|------|-------------|
| `--saveconf <file>` | Create configuration file with provided options |
| `--conf <file>` | Load configuration from file (CLI flags override) |

---

### **File server**
| Flag | Description |
|------|-------------|
| `--serve <path>` | Serve files from a local directory via simple web server |

---

### **AutoReconnect**
| Flag | Description |
|------|-------------|
| `--autoreconnect`, `-a` | Automatically reconnect tunnel on failure (enabled by default; pass `false` to disable) |

---

### **Remote control**
| Flag | Description |
|------|-------------|
| `--remote-management <token>` | Enable remote tunnel management |
| `--manage <addr>` | Remote management server (default: `dashboard.pinggy.io`) |
| `--NoTui` | Disable TUI in remote management mode |

---

### **Tunnel lifecycle**
| Flag | Description |
|------|-------------|
| `-b` | Start the tunnel detached (daemon keeps it alive after the CLI exits). Pairs with `pinggy start`. |
| `--all` | Start every config marked auto-start. Pairs with `pinggy start`. |
| `--auto` | Mark a saved config as auto-start. Pairs with `pinggy config save`. |

---

### **Misc**
| Flag | Description |
|------|-------------|
| `--version` | Print version and exit |
| `-h`, `--help` | Show help and exit |


### Extended options
Extended options provide advanced controls. Specify them as positional values like x:https or w:192.168.1.0/24 alongside other CLI flags.

- x:https           Enforce HTTPS-only (HTTP redirected to HTTPS).
- x:passpreflight | x:allowpreflight  Allow CORS preflight to pass unchanged.
- x:reverseproxy                  Disable built-in reverse-proxy header injection.
- x:xff                           Add X-Forwarded-For.
- x:fullurl | x:fullrequesturl    Include original request URL.
- x:haproxy | x:haproxy:v1 | x:haproxy:v2   Send HAProxy PROXY protocol header to the local server (default v1).
- w:<cidr>[,<cidr>...]            Whitelist IPs (IPv4 CIDR).
- k:<token>                       Set Bearer token(s) for auth (repeatable).
- b:<user:pass>                   Add Basic Auth credentials (repeatable).
- a:<Key:Val>                     Add header.
- u:<Key:Val>                     Update header.
- r:<Key>                         Remove header.

Examples:
- Enforce HTTPS and XFF for local HTTPS server on 8443:
  pinggy x:https x:xff -l https://localhost:8443

- Allow only a local subnet:
  pinggy w:192.168.1.0/24 -l 8080

- Send the real client IP to a PROXY-protocol-aware backend:
  pinggy x:haproxy:v2 -l 8080

To generate advanced CLI arguments, use [Configure from Pinggy.io](https://pinggy.io/)


## Saving and loading configuration
- Save current options to a file:
```bash
  pinggy -p 443 -L4300:localhost:4300 -t -R0:127.0.0.1:8000 qr+force@free.pinggy.io   x:noreverseproxy x:passpreflight x:xff --saveconf myconfig.json
```
- Use a config as base and override with flags:
```bash
pinggy --conf ./myconfig.json -p 8080
```


## Logging

The CLI has two layers of logging: per-invocation flags that affect what the current command prints, and daemon-wide log commands that read the persistent log files the daemon writes.

### Per-invocation flags
Pass these on any command that starts or interacts with a tunnel.

```bash
pinggy -p 3000 --logfile ~/.pinggy/pinggy.log --loglevel INFO --v
```
If you pass `--v`, `--vv`, or `--vvv` without a log level, the default is INFO. If a logfile path is provided, the log directory is created if it does not exist.

### Daemon and per-tunnel log files
The daemon writes its own log file and a separate log per tunnel under the platform log directory (see [State and file locations](#state-and-file-locations)).

#### Tail the daemon log
```bash
pinggy logs              # last 100 lines of the daemon log
pinggy logs -f           # follow new daemon log lines
```

#### Tail a tunnel log
```bash
pinggy logs my-tunnel    # last 100 lines of that tunnel's log
pinggy logs my-tunnel -f # follow new lines (survives log rotation)
```

#### Print the log file path
```bash
pinggy log path                # daemon log path
pinggy log path my-tunnel      # path to a specific tunnel's log
```

#### Get or set the daemon log level
```bash
pinggy log level                       # print current level
pinggy log level debug                 # set to debug, info, or error
```
Setting the level persists in `daemon-config.json` and applies to the daemon and any new tunnels. To pick up the new level on a tunnel that is already running, restart it with `pinggy restart <name>`.


## State and file locations

Config dir varies by OS:
- Linux/macOS: `~/.config/pinggy/`
- Windows: `%APPDATA%\pinggy\`

Log dir varies by OS:
- Linux: `~/.local/state/pinggy-cli/logs/` (honors `$XDG_STATE_HOME`)
- macOS: `~/Library/Logs/Pinggy-CLI/`
- Windows: `%LOCALAPPDATA%\Pinggy-CLI\Logs\`

Use `pinggy log path` to print the exact resolved paths on your system.

## File server mode
Serve a local directory quickly over a tunnel:
`  pinggy --serve /path/to/files`
Optionally combine with other flags (auth, IP whitelist) as needed.


## Signals and shutdown

- **Foreground tunnel**: Ctrl+C closes the TUI. The daemon arms a 5-second grace timer and stops the tunnel if no other CLI re-attaches.
- **Detached tunnel** (`-b`): the CLI already exited. Stop it with `pinggy stop <name|id>`.
- **Everything at once**: `pinggy daemon stop` stops every tunnel and shuts the daemon down cleanly. `daemon-state.json` is cleared, so nothing replays on next start.


## Versioning
This package follows semantic versioning. See package.json for the current version.


## License
Apache License Version 2.0
