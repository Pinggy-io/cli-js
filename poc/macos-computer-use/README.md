# Computer-use PoC

The cli-js half of the computer-use PoC for `docs/pinggy-devices/computer-use-agent-host.md` in the
`pinggy_backend` repo. `node src/main.cjs remote <scenario>` plays the CLI daemon, the agent and the
dashboard. The Pinggy app (`Pinggy-io/app`, `src/main/computerUsePoc/`) is the screen provider: it holds the
screen and input permissions, proves itself with its own key, and runs each session the dashboard signed a
grant for.

The PoC is not part of the CLI build. It needs `ws`, which resolves from the cli-js `node_modules`.

| File | Role |
|---|---|
| `src/screenDaemon.cjs` | Stand-in for the CLI daemon: `/ws/screen` on 127.0.0.1, refuses any `Origin` header, checks the proof, 1 provider at a time, sends requests |
| `src/fakeDashboard.cjs` | Stand-in for the dashboard: checks the proof against the registered app key, signs Ed25519 grants |
| `src/remote.cjs`, `src/main.cjs` | The scenarios. Each starts the daemon, waits up to 15 s for the app, runs, stops |
| `scripts/probe.cjs`, `scripts/dialogWindows.swift` | Runs 1 command and watches for a macOS Keychain dialog, a window of `SecurityAgent` |

| File in the app repo | Role |
|---|---|
| `src/main.js` | With `--cu-poc-check` or `--cu-poc-service`, runs the PoC instead of the main window and tray |
| `computerUsePoc/index.js` | Picks the helper, driver and check for the platform. Starts the provider |
| `computerUsePoc/screenProvider.js` | Polls for the daemon every second, connects, proves itself, checks each grant, runs sessions |
| `computerUsePoc/appKey.js`, `appKeyStore.js`, `grant.js` | The app key and the proof. The key store: the Keychain on macOS, DPAPI on Windows. The grant check: signature, app key, both nonces, expiry |
| `computerUsePoc/consent.js` | Allow / Deny with the client name from the grant, the sign, Stop, the shortcut |
| `computerUsePoc/daemonCheck.js`, `windowsDaemonCheck.js` | Before connecting: the daemon pid listens on the port, and its binary's signature. Reported, not enforced |
| `computerUsePoc/jxaHelper.js`, `macScreenDriver.js`, `checks.js` | macOS: 1 `osascript -l JavaScript` helper for permissions, `CGEvent` input and the Accessibility tree. `screencapture` for images. The permission check |
| `computerUsePoc/keychain.js`, `native/keychain.c` | macOS: the Keychain addon, loaded from the bundle's `Resources` |
| `computerUsePoc/windowsHelper.js`, `windowsScreenDriver.js`, `windowsChecks.js` | Windows: see "On Windows" |
| `scripts/cu-poc.sh`, `scripts/cu-poc.ps1` | `build`, `run [--request]`, `serve [--request]`, `stop`, on macOS and on Windows |

The PoC files sit in `~/.config/pinggy-cu-poc/` (`%APPDATA%\pinggy-cu-poc` on Windows), never in
`~/.config/pinggy/`, so the user's CLI daemon is not touched.

PoC shortcuts the real build does not take:

- The app registers its key by writing `app-key.json` when it makes the key, and the stand-in dashboard
  trusts that file. The real app registers at enrollment.
- The app reads the dashboard's public key from `dashboard-public.pem`. The real app ships it.
- The daemon check is not enforced, since the stand-in daemon is `node`.

## On macOS

`scripts/cu-poc.sh build` packages the app and copies it to `Pinggy CU PoC.app` with bundle id
`io.pinggy.cu-poc`, so its grants never touch the installed `Pinggy.app` (`com.electron.pinggy`). The copy
also runs under its own app name, `Pinggy CU PoC`: its own user data, logs
(`~/Library/Logs/Pinggy CU PoC/main.log`), single-instance lock, and Chromium cookie key
(`Pinggy CU PoC Safe Storage`). It can run beside the installed app. Build with Node 22, as the app's
`release.yml` does.

```
CU_POC_SIGN_IDENTITY=<SHA-1 from `security find-identity -v -p codesigning`> scripts/cu-poc.sh build
```

Sign with an identity that has a Team ID, such as an Apple Development certificate. The app's Keychain items
and its TCC grants then survive rebuilds, as they do for a Developer ID release. With `CU_POC_SIGN_IDENTITY`
unset, the copy is ad-hoc signed, and both are tied to 1 build. `tccutil reset All io.pinggy.cu-poc` clears
the copy's grants only.

```
scripts/cu-poc.sh serve                           # in the app repo: start the provider
node src/main.cjs remote status
node src/main.cjs remote session --client Claude  # Allow in the dialog: 1 capture, 1 move, end
node src/main.cjs remote session --pre-approved   # no dialog
node src/main.cjs remote hold                     # Allow, renew every 60 s, press Stop on the sign
node src/main.cjs remote hold --no-renew          # Allow, the app ends it after 120 s: grant_expired
node src/main.cjs remote forged-grant             # also expired-grant, replayed-grant
node src/main.cjs remote fake-provider
scripts/cu-poc.sh stop
```

### Which process gets the permission

macOS 26.2, arm64, ad-hoc signature. A `pkg` binary of the CLI checked each permission in 3 modes, and the
app copy in the 4th.

| | Terminal (cmux) | Daemon child (`pinggy start -b`) | LaunchAgent (`daemon install-service`) | Pinggy app |
|---|---|---|---|---|
| Responsible process of the check | cmux | cmux | the binary | `Pinggy CU PoC.app` |
| Responsible process of the `osascript` helper | cmux | cmux | the binary | `Pinggy CU PoC.app` |
| `screencapture` with no grant | exit 1, `could not create image from display` | same | same | same |
| AX read with no grant | `-25211`, no prompt | same | same | same |
| Posted mouse move with no grant | dropped, no prompt, no error | same | same | same |
| Screen Recording request | not run | not run | notice names the binary, no Allow button | already on |
| Accessibility request | not run | not run | no prompt | prompt names `Pinggy CU PoC`, "Open System Settings" |
| Entry in System Settings | | | none listed | `Pinggy CU PoC` in both lists |
| Works after the grant | not run | not run | not run | yes |

- `pinggy start -b` gives the daemon no identity of its own. The terminal stays responsible, so a grant
  lands on the terminal app.
- A LaunchAgent makes the binary responsible, but a bare binary gets no usable entry in System Settings:
  `tccd` logs `does not allow prompting; returning denied` for Screen Recording, and the `osascript` child
  can't ask for Accessibility (`check-by-audit-token` entitlement missing).
- TCC stores an ad-hoc grant by cdhash (`Failed to match existing code requirement`), so it does not
  survive a rebuild.
- In the app, the Accessibility prompt comes from Electron's `isTrustedAccessibilityClient(true)` in the
  main process. After the grant, every child of the app uses the app's grant: `screencapture` shows other
  apps' windows, the posted move lands, and the `osascript` helper reads the Finder AX tree (41 nodes).
- The JXA bridge rejects AX elements with `Ref has incompatible type` unless the 2 AX functions are bound
  with `id` types. `jxaHelper.js` binds them that way.

### WebSocket results

macOS 26.2, arm64. The stubbed runs load the app's `screenProvider.js` under Node with Electron and the
driver stubbed. The app runs use the built `Pinggy CU PoC.app`: first with no grants after the rebuild, then
with both grants.

| Scenario | Stubbed | App |
|---|---|---|
| `status` | `ready` | `screen_permission_missing`, then `ready` with the grants |
| `capture-without-session` | `no_session` | `no_session` |
| `forged-grant`, `expired-grant` | `grant_invalid`, no dialog | the same |
| `replayed-grant` | the app reconnects in about 1 s, the old grant answers `grant_invalid` | the same |
| `fake-provider` | browser `Origin`: HTTP 403. Forged proof: `provider_rejected`, `proof_invalid`. The app stays the provider | the same |
| `session --client Claude` | `active`. The dialog reads "Claude wants to control this computer" | No grants: `unavailable`, `screen_permission_missing`. Granted: Allow after 32 s, then 1 capture (99 KB) and 1 move to the center |
| `session --pre-approved` | `active`, no dialog | `active`, no dialog. The capture shows the real screen and the sign on top. 1280x800, 105 KB, 5 frames at 32 KB, 256 ms |
| `session`, Deny | `denied` | not run |
| `hold`, app killed after 1 renewal | 1 renewal accepted, then `app_not_running` | not run |
| `hold`, Stop on the sign | not run | 1 renewal accepted, `user_stopped` after 64 s, then `capture` answers `no_session` |
| `hold --no-renew` | `grant_expired` after 120 s | not run |

A grant from an earlier build does not apply to a rebuild. The Settings entry stays on, and `tccd` logs
`Failed to match existing code requirement`. `tccutil reset ScreenCapture io.pinggy.cu-poc` and
`tccutil reset Accessibility io.pinggy.cu-poc`, then `serve --request`, give fresh entries. "Quit & Reopen"
in Settings starts the app without `--cu-poc-service`. Run `stop`, then `serve` again.

Other numbers: the daemon check takes 80 to 100 ms. On the stand-in daemon it reads `node`, signed by
"Developer ID Application: Node.js Foundation". The grant check runs before the permission check, so a
bad grant never reaches a dialog or a permission prompt.

### The app key in the Keychain

The app's private key is 1 generic password item in the login keychain: service `io.pinggy.cu-poc.app-key`,
account `screen-provider`. The item trusts only the app. A missing item means a first start: the app makes a
key, stores it, and registers it. Any other Keychain error stops the provider instead of making a new key.

macOS 26.2, arm64. The copy is signed with an Apple Development certificate, Team ID `ACQ49YWZF2`.
`scripts/probe.cjs` runs each step and watches for a Keychain dialog:

```
node scripts/probe.cjs "restart" -- <app repo>/scripts/cu-poc.sh serve
```

| # | Step | Dialog | Result |
|---|---|---|---|
| 1 | First start | No | Key made and registered. The item trusts only the app, partition `teamid:ACQ49YWZF2` |
| 2 | `remote status`, `remote fake-provider` | No | The proof verifies. 403 and `proof_invalid` for the fakes, as before |
| 3 | Restart | No | Same key id. The registration is not rewritten |
| 4 | Update: new cdhash, same certificate | No | Same key id |
| 5 | `/usr/bin/security` or `node` reads the key | Yes, after 0.4 s | With interaction off: `-25293`, no dialog |
| 6 | `node` overwrites the key with its own | No | The write succeeds. The partition becomes `teamid:HX7739G8FX` (Node.js) |
| 6b | The app restarts after the overwrite | Yes, after 2.9 s | Allow was clicked. The app loaded the other key, id `b08eec9d...` |
| 6c | `remote status` with that key | | `proof_invalid` at each of 15 attempts, then `app_not_running` |
| 7 | `/usr/bin/security delete-generic-password` | No | The item is gone. The next start makes and registers a new key |

What it shows:

- With a Team ID, the key survives restarts and updates with no dialog. The ad-hoc copy asked at each
  rebuild.
- Other programs can't read the key without a dialog.
- Other programs can replace or delete the key with no dialog. Replacing it is an outage, not a takeover:
  the dashboard knows the registered key, so the proof fails. Here the stand-in daemon checks it.
- On a failed proof the app retries every second without end. The real app stops and tells the user to
  sign in again.
- The Keychain call blocks the main process while its dialog shows, as `safeStorage` does.

### The Keychain for the CLI's own secrets

An earlier run stored a CLI secret, such as the device token, in the login keychain from a `pkg` binary,
through the same addon. macOS 26.2, arm64.

| How the CLI runs | Dialogs | Protects the secret from other programs |
|---|---|---|
| Release binary, Developer ID | None, updates included (the Team ID case above) | Reading: yes. Overwriting or deleting: no |
| Local or ad-hoc build | The login password at each rebuild, for the CLI and its daemon child | Reading: yes. Overwriting or deleting: no |
| `npm install -g`, under `node` | None | No. Every `node` script, of any Node version, reads it |
| Over SSH, or as a system service | Can't show. The read fails at once (`-25293`) | |
| The Pinggy app reads the CLI's item | Yes, unless both share 1 Team ID | |

- Each item has an access list and a partition list, and a read needs both to match. The partition holds
  `teamid:<Team ID>`, or `cdhash:<hash>` for a binary with no Team ID, so an ad-hoc or self-signed rebuild
  breaks the match.
- A write replaces the partition list with the writer's partition, with no dialog. That locks the owner out
  until someone types the login password.
- "Always Allow" asks for the login password and adds the reader to both lists. 1 "Always Allow" for
  `/usr/bin/security` opens the item to every script that calls it.
- A dialog outlives its requester: killing the reader leaves it on screen, and the next request queues
  behind it. `probe.cjs` stops `SecurityAgent` to close it.
- The data-protection keychain refuses a plain CLI binary: `-34018`, a required entitlement is missing.

## On Windows

Windows asks for no screen or input permission. Any program of the user can capture the screen, send
input and read UI Automation. The app is still the provider, because it shows the dialog and the sign, and
the protocol stays the same. Same-user malware can already capture and type on Windows, so the PoC does not
defend against it there.

| File in the app repo | Role |
|---|---|
| `src/main/computerUsePoc/windowsHelper.js` | 1 long-lived Windows PowerShell that compiles a C# class with `Add-Type`, then answers JSON lines like `jxaHelper.js`: DPI-aware capture of the primary monitor, `SendInput` mouse and keys, Unicode typing, UI Automation of the foreground window, window titles, the input desktop |
| `src/main/computerUsePoc/windowsScreenDriver.js` | `status`, `capture`, `input`. `secure_desktop` when UAC or the lock screen holds the input desktop |
| `src/main/computerUsePoc/windowsChecks.js` | `--cu-poc-check` on Windows: each operation once, with its result or error |
| `src/main/computerUsePoc/windowsDaemonCheck.js` | The pid that listens on the port, its path, its Authenticode signature. Reported, not enforced |
| `src/main/computerUsePoc/appKeyStore.js` | The app key: the Keychain on macOS, `safeStorage` (DPAPI) in `app-key.dpapi` on Windows |
| `scripts/cu-poc.ps1` | `build`, `run`, `serve`, `stop`. No copy and no bundle id: there are no grants to keep apart |

On Windows the files sit in `%APPDATA%\pinggy-cu-poc`, the reports and screenshots in
`%LOCALAPPDATA%\pinggy-cu-poc\Logs`, and the app log in `%APPDATA%\Pinggy CU PoC\logs\main.log`.
Coordinates are physical pixels of the primary monitor. `cmd` in a key combo sends Ctrl, and `win` the
Windows key. The stop shortcut is Ctrl+Alt+Shift+S. On Windows the consent prompt is an always-on-top
window, not a dialog box.

The C# compiles at the first helper call, on the Windows machine. A compile error shows as
`helper exited 1: ...` in the report or the log.

### Windows test steps

Needs Node 22, or Node 24 with npm 10 (`npm install -g npm@10`). Keep the Remote Desktop window open and not
minimized: a minimized session stops drawing, and capture then fails. Over SSH, build only: a process
started from SSH runs in a session with no desktop.

```
# app repo, PowerShell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\cu-poc.ps1 build
powershell -ExecutionPolicy Bypass -File scripts\cu-poc.ps1 run      # the operations check, then quit

# cli-js repo: ws for the stand-in daemon
cd poc\macos-computer-use
npm install --no-save ws@8

# app repo
powershell -ExecutionPolicy Bypass -File scripts\cu-poc.ps1 serve

# cli-js repo, poc\macos-computer-use
node src\main.cjs remote status
node src\main.cjs remote session --client Claude   # Allow in the window: 1 capture, 1 move to the center
node src\main.cjs remote hold                      # Allow, then Stop on the sign, or Ctrl+Alt+Shift+S
node src\main.cjs remote forged-grant              # also expired-grant, replayed-grant
node src\main.cjs remote fake-provider

# app repo
powershell -ExecutionPolicy Bypass -File scripts\cu-poc.ps1 stop
```

What to record:

| Step | Check |
|---|---|
| `run` | `status.result`: `input_desktop` is `Default`, `dpi_awareness`, the screen size. `capture` writes a JPEG of the real screen. `uia_tree.result.node_count` above 1. `input_probe.result.moved` is `true` |
| `serve` | `provider.json` appears. `app-key.dpapi` appears on the first start, and the key id stays the same on the next |
| `remote status` | `state: ready`. `daemon_check` names `node.exe` and its signer |
| `remote session` | The consent window shows in front. The sign stays on top. The cursor lands on the screen center at 100% and at 150% scaling |
| `remote hold` | Stop on the sign and the shortcut both end it: `user_stopped` |
| `forged-grant`, `fake-provider` | `grant_invalid`, HTTP 403, `proof_invalid`, as on macOS |
| An elevated window in front, such as Task Manager | Input does not reach it. Record what `input` answers |
| Win+L, or a UAC prompt, during `hold` | `status` answers `secure_desktop` |

### Windows results

Windows Server VM over Remote Desktop, 2048x1280, Node 24 with npm 10, the built-in Administrator account,
so every process runs elevated.

| Step | Result |
|---|---|
| `run` | The helper compiles at the first call: 4.4 s. Capture 1280x800 in 276 ms, `per_monitor_v2`, UI Automation 14 nodes, the input probe moved. Chromium's own DXGI capture fails over Remote Desktop, the helper's GDI capture works |
| `remote status` | `ready`, input desktop `Default`. The daemon check: the pid listens on the port, `node.exe` signed by the OpenJS Foundation, `Valid`, 2.6 to 4.2 s per connect |
| `remote session --client Claude` | Allow, then 1 capture (86 KB, 318 ms) and 1 move: the cursor lands on 1024, 640, the center of 2048x1280. The sign shows on top |
| `remote hold`, Stop on the sign | `user_stopped` after 4 s, then `capture` answers `no_session` |
| `forged-grant`, `expired-grant` | `grant_invalid`, no dialog |
| `replayed-grant` | The app reconnects in 3 s. The old grant answers `grant_invalid` |
| `fake-provider` | browser `Origin`: HTTP 403. Forged proof: `proof_invalid`. The app stays the provider |
| App key | The same key id across restarts, from `app-key.dpapi` |
| The consent dialog box | Only a taskbar flash: Windows keeps a background app from taking the foreground. Allow took 37 s. The always-on-top consent window replaces it on Windows. Not yet run |

Found on the way:

- `GetUserObjectInformation` without `CharSet.Unicode` binds the A version. The desktop name then reads as
  `敄慦汵t`, and every session answers `unavailable`. Fixed.
- The app's packaging hook runs `npm ci` with the machine's npm. npm 11 refuses the lock file, so npm 10 is
  needed for both installs.

Not run yet: the always-on-top consent window, Deny, Ctrl+Alt+Shift+S, Win+L during `hold`, 150% scaling,
and an elevated window in front from a non-admin account. As Administrator, every process is elevated, so
UIPI blocks nothing.

On Windows any program of the user can click Allow with `SendInput`. macOS needs the Accessibility grant to
post a click.
