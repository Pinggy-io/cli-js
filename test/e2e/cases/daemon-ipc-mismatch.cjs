const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  sandbox,
  runSubcommand,
  stripAnsi,
} = require('../lib/framework.cjs');

// Simulates a daemon left behind by a different CLI build: a live PID whose
// daemon.json carries a foreign (or missing) ipcVersion. Every daemon-facing
// command must refuse with the mismatch message and leave daemon.json alone.
module.exports = {
  name: 'daemon-ipc-mismatch',
  async run() {
    sandbox.reset();

    // A live process that is not a daemon. Its PID passes the liveness check.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const dir = path.dirname(sandbox.daemonJsonPath());
    fs.mkdirSync(dir, { recursive: true });
    const writeInfo = (extra) => fs.writeFileSync(
      sandbox.daemonJsonPath(),
      JSON.stringify({ pid: holder.pid, port: 1, startedAt: new Date().toISOString(), ...extra }),
      'utf-8'
    );

    try {
      // Old build: no ipcVersion field at all.
      writeInfo({});
      const ps = await runSubcommand(['ps']);
      const psOut = stripAnsi(ps.combined);
      if (!/different Pinggy CLI version/i.test(psOut) || !/daemon IPC v0/.test(psOut)) {
        throw new Error(`ps did not report IPC mismatch for legacy daemon.json; got: ${psOut.slice(0, 400)}`);
      }
      if (!/pinggy daemon stop/.test(psOut)) {
        throw new Error(`ps mismatch message lacks the fix hint; got: ${psOut.slice(0, 400)}`);
      }
      if (!fs.existsSync(sandbox.daemonJsonPath())) {
        throw new Error('daemon.json was removed although the daemon PID is alive');
      }

      // Newer build: explicit foreign version.
      writeInfo({ ipcVersion: 9999 });
      const start = await runSubcommand(['daemon', 'start']);
      const startOut = stripAnsi(start.combined);
      if (start.code === 0 || !/daemon IPC v9999/.test(startOut)) {
        throw new Error(`daemon start should fail on IPC mismatch; exit=${start.code} out: ${startOut.slice(0, 400)}`);
      }

      const status = await runSubcommand(['daemon', 'status']);
      const statusOut = stripAnsi(status.combined);
      if (!/IPC:\s*v9999/.test(statusOut) || !/Warning:/.test(statusOut)) {
        throw new Error(`daemon status should show IPC version and a mismatch warning; got: ${statusOut.slice(0, 500)}`);
      }
    } finally {
      try { holder.kill('SIGKILL'); } catch {}
      try { fs.unlinkSync(sandbox.daemonJsonPath()); } catch {}
    }
  },
};
