# Pinggy CLI 

Create secure, shareable tunnels to your localhost and manage them from the command line. 


## Key features
- HTTP, TCP, UDP, TLS, TLSTCP tunnels to localhost
- SSH-style and user-friendly flags
- Web debugger for HTTP tunnels
- Extended options for auth, header manipulation, IP allowlists, CORS handling, etc.
- Remote management via secure WebSocket connection (works with Pinggy Dashboard)
- Configurable logging to file and/or stdout
- Save and load configuration files
- Simple file server mode for quickly sharing local files
- Built-in TUI (Text User Interface) for viewing tunnel statistics, requests, and responses in real time


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

The CLI prints generated public URLs (HTTP/HTTPS or TCP) and keeps running until you press Ctrl+C.


## Usage
Basic syntax:
  pinggy [options] [user@domain]

- user@domain is optional. Domain can be any valid domain supported by the service backend (e.g., ap.example.com).

### Options
The CLI supports both SSH-style flags and more descriptive long flags. Below is a consolidated list (only public ones are shown here). For the most up-to-date help, run pinggy --help.

- -R, --R <value>              Local port forwarding (SSH-style).
  Example: -R0:localhost:3000 forwards tunnel traffic to local port 3000.
- -L, --L <value>              Web debugger address (SSH-style).
  Example: -L4300:localhost:4300 starts web debugger on port 4300.
- -p, --server-port <value>    Pinggy server port (default: 443).
- --type <value>               Type of connection (e.g., tcp for raw TCP tunnel).
- -l, --localport <value>      Local endpoint as [protocol:][host:]port.
  Examples: --localport https://localhost:8000 or -l 3000
- -d, --debugger <value>       Port for web debugger (e.g., -d 4300).
- --token <value>              Token for authentication.

Logging:
- --loglevel <value>           Logging level: ERROR, INFO, DEBUG.
- --logfile <path>             Path to log file.
- --v                          Print logs to stdout for Cli.
- --vv                         Enable detailed logging for the Node.js SDK and Libpinggy.
- --vvv                        Enable logs from Cli, SDK and Libpinggy.

Config:
- --saveconf <file>            Create a configuration file based on the provided options.
- --conf <file>                Load configuration from file; CLI options override it.

File server:
- --serve <path>               Serve files from a local directory via a simple web server.

Remote control:
- --remote-management <token>  Enable remote management of tunnels using api key.
- --manage <addr>              Remote management server (default: dashboard.pinggy.io).
- --NoTUI                      Disable TUI in remote management mode.

Misc:
- --version                    Print version and exit.
- -h, --help                   Show help and exit.


### Extended options
Extended options provide advanced controls. Specify them as positional values like x:https or w:192.168.1.0/24 alongside other CLI flags.

- x:https           Enforce HTTPS-only (HTTP redirected to HTTPS).
- x:passpreflight | x:allowpreflight  Allow CORS preflight to pass unchanged.
- x:reverseproxy                  Disable built-in reverse-proxy header injection.
- x:xff                           Add X-Forwarded-For.
- x:fullurl | x:fullrequesturl    Include original request URL.
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

To generate advanced CLI arguments, use [Configure from Pinggy.io](https://pinggy.io/)


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



## Logging
You can control logs via CLI flags (which override environment variables). If logfile is provided, the log directory will be created if it does not exist.

- To log to file and stdout at INFO level:
```bash
  pinggy -p 3000 --logfile ~/.pinggy/pinggy.log --loglevel INFO --v
```
If you provide --v, --vv, or --vvv without specifying a log level, the default log level is INFO.



## Saving and loading configuration
- Save current options to a file:
```bash  
  pinggy -p 443 -L4300:localhost:4300 -t -R0:127.0.0.1:8000 qr+force@free.pinggy.io   x:noreverseproxy x:passpreflight x:xff --saveconf myconfig.json
```
- Use a config as base and override with flags:
```bash
pinggy --conf ./myconfig.json -p 8080
```


## File server mode
Serve a local directory quickly over a tunnel:
  pinggy --serve /path/to/files
Optionally combine with other flags (auth, IP whitelist) as needed.


## Signals and shutdown
Press Ctrl+C to stop. The CLI traps SIGINT and gracefully stops active tunnels before exiting.



## Versioning
This package follows semantic versioning. See package.json for the current version.


## License
Apache License Version 2.0
