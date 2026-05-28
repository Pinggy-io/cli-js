const fs = require('fs');
const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  readDaemonState,
  withEcho,
  sleep,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'clean-shutdown-clears-state',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      let stopped = false;
      try {
        const save = await runSubcommand(['config', 'save', 'cleancfg', '-l', String(echo.port)]);
        if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

        const start = await runSubcommand(['start', 'cleancfg', '-b'], { timeoutMs: 60000 });
        if (start.code !== 0) throw new Error(`start exit=${start.code}: ${start.combined.slice(0, 600)}`);

        const state = readDaemonState();
        if (!state || state.tunnels.length !== 1) {
          throw new Error(`expected 1 tunnel in state; got ${state ? state.tunnels.length : 'no state'}`);
        }

        const stop = await runSubcommand(['stop', 'cleancfg']);
        if (stop.code !== 0) throw new Error(`stop exit=${stop.code}: ${stop.combined.slice(0, 400)}`);

        await sleep(500);
        const afterStop = readDaemonState();
        if (!afterStop || afterStop.tunnels.length !== 0) {
          throw new Error(`expected empty tunnels after stop; got ${JSON.stringify(afterStop)}`);
        }

        await stopDaemon();
        stopped = true;

        if (fs.existsSync(sandbox.daemonStatePath())) {
          throw new Error(`daemon-state.json should be removed on clean shutdown`);
        }
      } finally {
        if (!stopped) await stopDaemon();
      }
    });
  },
};
