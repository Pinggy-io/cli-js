# Pinggy CLI E2E Tests

End-to-end tests that exercise the packaged `pkg` binary against real Pinggy free-tier tunnels. Each case spawns the CLI, waits for the tunnel to come up, then asserts behavior over the live HTTPS / TCP / UDP endpoint.

## Run

```bash
node test/e2e/run.cjs <path-to-binary>
```

Examples:

```bash
node test/e2e/run.cjs out/pinggy-macos-arm64
node test/e2e/run.cjs out/pinggy-linux-x64
```

The runner exits non-zero on the first failure. A summary is printed at the end.

CI runs the same command across 6 platforms in `.github/workflows/e2e-test.yml`.

## What gets tested

| Case | Verifies |
|---|---|
| `serve` | `--serve <dir>` static file mode returns the expected HTML over the tunnel |
| `headers` | `a:` adds, `u:` updates, `r:` removes request headers. `x:xff` reaches the SDK config |
| `basic-auth` | `b:user:pass` returns 401 for no/wrong creds and 200 for correct |
| `bearer-auth` | `k:TOKEN` returns 401 without bearer and 200 with `Authorization: Bearer TOKEN` |
| `whitelist-allow` | `w:<runner-ip>/32` allows the runner. IP is parsed from the previous tunnel URL |
| `whitelist-deny` | `w:10.0.0.1/32` blocks the runner. Connection-level rejection accepted as denial |
| `https-only` | `x:https` rejects HTTP and serves HTTPS |
| `tcp` | `tcp@free.pinggy.io` exposes a real `tcp://host:port`. Echo roundtrip succeeds |
| `udp` | `udp@free.pinggy.io` exposes a real `udp://host:port`. Echo roundtrip succeeds |
| `config-roundtrip` | `--saveconf` writes a file. A second run with `--conf` works |
| `debugger-ws` | `/introspec/websocket` emits a `{req, res}` frame for a tunneled request |

## debugger-ws in detail

The web debugger (configured with `-L<port>:localhost:<port>`) exposes two endpoints on that local port:

- `GET /urls` — JSON list of active tunnel URLs
- `WS /introspec/websocket` — a stream that pushes one JSON frame per request/response pair flowing through the tunnel

The first is used elsewhere in the suite as a fallback liveness signal. This case is the only one that exercises the second. The TUI subscribes to the same WebSocket to render its live request log, so a regression here would ship a CLI whose tunnels work but whose TUI never updates.

The case:

1. Starts an HTTP echo backend.
2. Spawns the CLI with a normal HTTP tunnel and `-L<port>:localhost:<port>`.
3. Opens a WebSocket to `ws://<host>:<port>/introspec/websocket`. Tries `localhost`, `127.0.0.1`, `[::1]` in turn so the test does not care which loopback the SDK happens to bind.
4. Makes one HTTPS request through the tunnel.
5. Polls the WebSocket message buffer for up to 15 s waiting for a frame where `f.req || f.res` is truthy.
6. Fails with a diagnostic dump of received frames if nothing matching arrives.

The frame schema (`{req: {key, method, uri}, res: {key, status}}`, defined in `src/tui/blessed/webDebuggerConnection.ts`) is matched loosely. The test asserts that *some* recognisable frame arrives rather than pinning every field, so harmless schema additions do not break it.

## Layout

```
test/e2e/
  run.cjs                  # entry: arg parsing, case registry, main loop
  echo-http.cjs            # HTTP backend that echoes request as JSON
  echo-tcp.cjs             # raw TCP echo backend
  echo-udp.cjs             # UDP datagram echo backend
  lib/
    cli.cjs                # process lifecycle, log/URL tunnel detection
    framework.cjs          # state, runCase, withTunnel, withEcho, buildArgs, helpers
  cases/<case-name>.cjs    # one file per test case
```

The `lib/cli.cjs` module spawns the binary, watches the log file for `Tunnel started {...,"urls":[...]}`, and falls back to `/urls` polling. Cross-platform process termination uses `taskkill /T /F` on Windows and `SIGTERM` then `SIGKILL` on Unix.

The `lib/framework.cjs` module owns shared state (workdir, debugger-port counter, public IP parsed from URL) and exports the helpers cases compose:

- `withTunnel({ name, build }, fn)` spawns the CLI with `buildArgs(build)`, waits for URLs, calls `fn({ urls, dbg, log })`, kills the process on exit.
- `withEcho(kind, fn)` starts an HTTP / TCP / UDP echo backend, calls `fn(echo)`, stops the backend.
- `buildArgs({...})` constructs SSH-style invocations: `-R0:localhost:<port> -L<dbg>:localhost:<dbg> [type@]free.pinggy.io [extOpts...]`.
- `SkipCase` is an `Error` subclass. Throwing it from a case marks the case `SKIP` instead of `FAIL`.

## Add a new case

1. Create `cases/<name>.cjs`:

```js
const { withTunnel, withEcho, pickHttpsUrl } = require('../lib/framework.cjs');

module.exports = {
  name: '<name>',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: '<name>', build: { localPort: echo.port, extOpts: ['<flag>'] } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);
          // assertions...
        }
      )
    );
  },
};
```

2. Register it in `run.cjs`:

```js
const cases = [
  // ...
  require('./cases/<name>.cjs'),
];
```

