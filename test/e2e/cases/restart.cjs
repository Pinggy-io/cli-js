const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  ipcRequest,
  withEcho,
  fetchJson,
  sleep,
} = require('../lib/framework.cjs');

async function getTunnelByName(name) {
  const list = await ipcRequest('GET', '/tunnels');
  if (list.status !== 200 || !Array.isArray(list.json)) {
    throw new Error(`/tunnels failed: status=${list.status}`);
  }
  return list.json.find((t) => (t.tunnelconfig && t.tunnelconfig.name) === name) || null;
}

function extractHttpsUrl(text) {
  const m = text.match(/https:\/\/\S+/);
  return m ? m[0] : null;
}

module.exports = {
  name: 'restart',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      try {
        const save = await runSubcommand(['config', 'save', 'rstcfg', '-l', String(echo.port)]);
        if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

        const start = await runSubcommand(['start', 'rstcfg', '-b'], { timeoutMs: 60000 });
        if (start.code !== 0) throw new Error(`start exit=${start.code}: ${start.combined.slice(0, 600)}`);

        const before = await getTunnelByName('rstcfg');
        if (!before) throw new Error(`tunnel "rstcfg" not in /tunnels after start`);
        const configIdBefore = before.tunnelconfig.configId;

        const restart = await runSubcommand(['restart', 'rstcfg'], { timeoutMs: 60000 });
        if (restart.code !== 0) throw new Error(`restart exit=${restart.code}: ${restart.combined.slice(0, 400)}`);
        if (!/restarting/i.test(restart.combined)) {
          throw new Error(`expected restarting message: ${restart.combined.slice(0, 400)}`);
        }

        let after = null;
        for (let i = 0; i < 60; i++) {
          await sleep(500);
          after = await getTunnelByName('rstcfg');
          if (after && after.status && after.status.state === 'running' && after.remoteurls && after.remoteurls.length) break;
        }
        if (!after) throw new Error('tunnel disappeared after restart');
        if (after.tunnelconfig.configId !== configIdBefore) {
          throw new Error(`configId changed: ${configIdBefore} -> ${after.tunnelconfig.configId}`);
        }

        const url = after.remoteurls.find((u) => u.startsWith('https://'));
        if (!url) throw new Error(`no https URL after restart: ${JSON.stringify(after.remoteurls)}`);
        const res = await fetchJson(url);
        if (res.status !== 200) {
          throw new Error(`fetch after restart status=${res.status}: ${res.text.slice(0, 300)}`);
        }

        await runSubcommand(['stop', 'rstcfg']);
      } finally {
        await stopDaemon();
      }
    });
  },
};
