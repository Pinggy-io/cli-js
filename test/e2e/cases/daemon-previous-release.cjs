const path = require('path');
const { sandbox, getBinary, runSubcommand, readDaemonInfo, waitForDaemonInfo, stopDaemon, SkipCase } = require('../lib/framework.cjs');
const { runBinary } = require('../lib/updates.cjs');

const TUNNEL_NAME = 'e2e-previous-daemon';

// After an update the CLI is newer than the daemon until the daemon restarts. The candidate must work with the last
// release's daemon, or report the IPC mismatch. Run with PINGGY_E2E_PREVIOUS_BINARY set to that release's binary.
module.exports = {
  name: 'daemon-previous-release',
  async run() {
    const previousBinary = process.env.PINGGY_E2E_PREVIOUS_BINARY;
    if (!previousBinary) throw new SkipCase('PINGGY_E2E_PREVIOUS_BINARY is not set');

    sandbox.reset();
    const started = runBinary(path.resolve(previousBinary), ['daemon', 'start']);
    if (started.code !== 0) throw new Error(`the previous release's daemon did not start: ${started.combined}`);
    await waitForDaemonInfo(8000);

    try {
      const candidateIpc = Number(runBinary(getBinary(), ['--_ipc-version']).stdout.trim());
      const ps = await runSubcommand(['ps']);

      if (readDaemonInfo().ipcVersion !== candidateIpc) {
        if (!/different Pinggy CLI version/i.test(ps.combined)) {
          throw new Error(`a different IPC version should report the mismatch: ${ps.combined}`);
        }
        return;
      }

      if (ps.code !== 0) throw new Error(`ps failed against the previous daemon: ${ps.combined}`);
      const saved = await runSubcommand(['config', 'save', TUNNEL_NAME, '-l', '8000']);
      if (saved.code !== 0) throw new Error(`config save failed: ${saved.combined}`);
      const start = await runSubcommand(['start', TUNNEL_NAME, '-b'], { timeoutMs: 60000 });
      if (start.code !== 0) throw new Error(`start -b failed against the previous daemon: ${start.combined}`);
      const stop = await runSubcommand(['stop', TUNNEL_NAME]);
      if (stop.code !== 0) throw new Error(`stop failed against the previous daemon: ${stop.combined}`);
    } finally {
      await stopDaemon();
    }
  },
};
