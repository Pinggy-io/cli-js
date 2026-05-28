const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  ipcRequest,
  readDaemonState,
  withEcho,
  fetchJson,
  sleep,
} = require('../lib/framework.cjs');

const GRACE_MS = 5000;

function extractHttpsUrl(text) {
  const m = text.match(/https:\/\/\S+/);
  return m ? m[0] : null;
} 

module.exports = {
  name: 'detached-survives-cli-exit',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      try {
        const save = await runSubcommand(['config', 'save', 'dtcfg', '-l', String(echo.port)]);
        if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

        const start = await runSubcommand(['start', 'dtcfg', '-b'], { timeoutMs: 60000 });
        if (start.code !== 0) throw new Error(`start -b exit=${start.code}: ${start.combined.slice(0, 600)}`);

        const url = extractHttpsUrl(start.combined);
        if (!url) throw new Error(`no https URL in start output: ${start.combined.slice(0, 600)}`);

        const state = readDaemonState();
        const tracked = state && Array.isArray(state.tunnels)
          ? state.tunnels.find((t) => t.name === 'dtcfg')
          : null;
        if (!tracked) {
          throw new Error(`detached tunnel missing from daemon-state.json: ${JSON.stringify(state)}`);
        }
        if (tracked.mode !== 'detached') {
          throw new Error(`expected daemon-state mode=detached; got ${tracked.mode}`);
        }

        const before = await ipcRequest('GET', '/tunnels');
        const beforeEntry = Array.isArray(before.json)
          ? before.json.find((t) => t.tunnelconfig && t.tunnelconfig.name === 'dtcfg')
          : null;
        if (!beforeEntry) throw new Error(`/tunnels did not list dtcfg after start`);
        if (beforeEntry.mode !== 'detached') {
          throw new Error(`expected /tunnels mode=detached; got ${JSON.stringify(beforeEntry.mode)}`);
        }

        await sleep(GRACE_MS + 3000);

        const after = await ipcRequest('GET', '/tunnels');
        const afterEntry = Array.isArray(after.json)
          ? after.json.find((t) => t.tunnelconfig && t.tunnelconfig.name === 'dtcfg')
          : null;
        if (!afterEntry) {
          throw new Error(`detached tunnel disappeared during grace window: ${JSON.stringify(after.json)}`);
        }
        if (!afterEntry.status || afterEntry.status.state !== 'running') {
          throw new Error(`detached tunnel no longer running: ${JSON.stringify(afterEntry.status)}`);
        }

        const res = await fetchJson(url);
        if (res.status !== 200) {
          throw new Error(`fetch through detached tunnel returned ${res.status}: ${res.text.slice(0, 300)}`);
        }
        if (!res.json || res.json.method !== 'GET') {
          throw new Error(`unexpected echo body: ${res.text.slice(0, 300)}`);
        }

        const stop = await runSubcommand(['stop', 'dtcfg']);
        if (stop.code !== 0) throw new Error(`stop exit=${stop.code}: ${stop.combined.slice(0, 400)}`);
      } finally {
        await stopDaemon();
      }
    });
  },
};
