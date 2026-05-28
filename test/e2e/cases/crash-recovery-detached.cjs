const fs = require('fs');
const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  ipcRequest,
  readDaemonState,
  readDaemonInfo,
  waitForDaemonInfo,
  withEcho,
  sleep,
  isPidAlive,
} = require('../lib/framework.cjs');

async function getTunnelByName(name) {
  const list = await ipcRequest('GET', '/tunnels');
  if (list.status !== 200 || !Array.isArray(list.json)) return null;
  return list.json.find((t) => (t.tunnelconfig && t.tunnelconfig.name) === name) || null;
}

module.exports = {
  name: 'crash-recovery-detached',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      const info = await startDaemon();
      let cleanedUp = false;
      try {
        const save = await runSubcommand(['config', 'save', 'crashcfg', '-l', String(echo.port)]);
        if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

        const start = await runSubcommand(['start', 'crashcfg', '-b'], { timeoutMs: 60000 });
        if (start.code !== 0) throw new Error(`start exit=${start.code}: ${start.combined.slice(0, 600)}`);

        const state = readDaemonState();
        if (!state || !Array.isArray(state.tunnels) || state.tunnels.length !== 1) {
          throw new Error(`daemon-state.json malformed or wrong count: ${JSON.stringify(state)}`);
        }
        if (state.tunnels[0].mode !== 'detached') {
          throw new Error(`tunnel mode should be detached: ${state.tunnels[0].mode}`);
        }
        if (state.tunnels[0].name !== 'crashcfg') {
          throw new Error(`state name mismatch: ${state.tunnels[0].name}`);
        }

        try { process.kill(info.pid, 'SIGKILL'); } catch {}
        for (let i = 0; i < 50; i++) {
          if (!isPidAlive(info.pid)) break;
          await sleep(100);
        }
        if (isPidAlive(info.pid)) throw new Error(`daemon PID ${info.pid} still alive after SIGKILL`);

        if (!fs.existsSync(sandbox.daemonStatePath())) {
          throw new Error(`daemon-state.json missing after SIGKILL — crash recovery cannot run`);
        }

        await startDaemon();

        let restored = null;
        for (let i = 0; i < 60; i++) {
          await sleep(500);
          restored = await getTunnelByName('crashcfg');
          if (restored && restored.status && restored.status.state === 'running' && restored.remoteurls && restored.remoteurls.length) break;
        }
        if (!restored) throw new Error('tunnel "crashcfg" not restored after daemon restart');
        if (!restored.remoteurls || !restored.remoteurls.length) {
          throw new Error(`restored tunnel has no URLs: ${JSON.stringify(restored.remoteurls)}`);
        }

        await runSubcommand(['stop', 'crashcfg']);
      } finally {
        if (!cleanedUp) await stopDaemon();
      }
    });
  },
};
