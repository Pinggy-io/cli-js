const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  withEcho,
  fetchJson,
  sleep,
} = require('../lib/framework.cjs');

function extractHttpsUrl(text) {
  const m = text.match(/https:\/\/\S+/);
  return m ? m[0] : null;
}

module.exports = {
  name: 'start-background',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      const daemonInfo = await startDaemon();
      try {
        const save = await runSubcommand(['config', 'save', 'bgcfg', '-l', String(echo.port)]);
        if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

        const start = await runSubcommand(['start', 'bgcfg', '-b'], { timeoutMs: 60000 });
        if (start.code !== 0) throw new Error(`start -b exit=${start.code}: ${start.combined.slice(0, 600)}`);
        if (!/Success.*bgcfg.*started|started.*ID/i.test(start.combined)) {
          throw new Error(`expected start success message: ${start.combined.slice(0, 600)}`);
        }

        const url = extractHttpsUrl(start.combined);
        if (!url) throw new Error(`no https URL in start output: ${start.combined.slice(0, 600)}`);

        await sleep(2000);
        const res = await fetchJson(url);
        if (res.status !== 200) {
          throw new Error(`fetch through tunnel returned ${res.status}: ${res.text.slice(0, 300)}`);
        }
        if (!res.json || res.json.method !== 'GET') {
          throw new Error(`unexpected echo body: ${res.text.slice(0, 300)}`);
        }

        const ps = await runSubcommand(['ps']);
        if (!/bgcfg/.test(ps.combined)) {
          throw new Error(`ps did not list bgcfg: ${ps.combined.slice(0, 400)}`);
        }

        const stop = await runSubcommand(['stop', 'bgcfg']);
        if (stop.code !== 0) throw new Error(`stop exit=${stop.code}: ${stop.combined.slice(0, 400)}`);
        if (!/stopped/i.test(stop.combined)) {
          throw new Error(`expected stop confirmation: ${stop.combined.slice(0, 400)}`);
        }

        await sleep(500);
        const ps2 = await runSubcommand(['ps']);
        const bgRow = ps2.combined.split('\n').find((l) => /bgcfg/.test(l));
        if (bgRow && /running/.test(bgRow)) {
          throw new Error(`bgcfg still "running" after stop: ${bgRow}`);
        }
      } finally {
        await stopDaemon();
      }
    });
  },
};
