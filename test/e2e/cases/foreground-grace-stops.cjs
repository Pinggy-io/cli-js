const fs = require('fs');
const path = require('path');
const {
  sandbox,
  workDir,
  runSubcommand,
  startDaemon,
  stopDaemon,
  ipcRequest,
  readDaemonState,
  withEcho,
  spawnCli,
  forceKill,
  dumpLogs,
  getBinary,
  waitForTunnelByName,
  waitForTunnelStopped,
  sleep,
} = require('../lib/framework.cjs');

const GRACE_MS = 5000;

module.exports = {
  name: 'foreground-grace-stops',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      let proc = null;
      const logFile = path.join(workDir, 'tunnel-fgcfg.log');
      try {
        const save = await runSubcommand(['config', 'save', 'fgcfg', '-l', String(echo.port)]);
        if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

        proc = spawnCli(getBinary(), ['start', 'fgcfg', '--noTui'], { logFile });

        const tunnel = await waitForTunnelByName('fgcfg', { maxMs: 60000 });
        if (!tunnel) {
          dumpLogs(logFile);
          throw new Error('foreground tunnel "fgcfg" never reached running state');
        }
        if (tunnel.mode !== 'foreground') {
          throw new Error(`expected mode=foreground; got ${JSON.stringify(tunnel.mode)}`);
        }

        const state = readDaemonState();
        const tracked = state && Array.isArray(state.tunnels)
          ? state.tunnels.find((t) => t.name === 'fgcfg')
          : null;
        if (tracked) {
          throw new Error(`foreground tunnel must not be in daemon-state.json: ${JSON.stringify(tracked)}`);
        }

        forceKill(proc);
        proc = null;

        const result = await waitForTunnelStopped('fgcfg', { maxMs: GRACE_MS + 7000 });
        if (!result) {
          dumpLogs(logFile);
          const list = await ipcRequest('GET', '/tunnels');
          throw new Error(`tunnel "fgcfg" still running after grace window: ${JSON.stringify(list.json)}`);
        }

        const ps = await runSubcommand(['ps']);
        const fgRow = ps.combined.split('\n').find((l) => /fgcfg/.test(l));
        if (fgRow && /running/.test(fgRow)) {
          throw new Error(`ps still shows fgcfg running: ${fgRow}`);
        }

        if (fs.existsSync(sandbox.daemonStatePath())) {
          const after = readDaemonState();
          const stillThere = after && Array.isArray(after.tunnels)
            ? after.tunnels.find((t) => t.name === 'fgcfg')
            : null;
          if (stillThere) {
            throw new Error(`daemon-state.json still tracks fgcfg after auto-stop: ${JSON.stringify(stillThere)}`);
          }
        }
      } finally {
        if (proc) forceKill(proc);
        await sleep(200);
        await stopDaemon();
      }
    });
  },
};
