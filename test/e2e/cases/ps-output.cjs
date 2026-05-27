const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  withEcho,
  sleep,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'ps-output',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      try {
        const emptyPs = await runSubcommand(['ps']);
        if (!/No tunnels running/i.test(emptyPs.combined)) {
          throw new Error(`empty ps unexpected output: ${emptyPs.combined.slice(0, 400)}`);
        }

        for (const name of ['ps-a', 'ps-b']) {
          const save = await runSubcommand(['config', 'save', name, '-l', String(echo.port)]);
          if (save.code !== 0) throw new Error(`save ${name} failed: ${save.combined.slice(0, 400)}`);
          const start = await runSubcommand(['start', name, '-b'], { timeoutMs: 60000 });
          if (start.code !== 0) throw new Error(`start ${name} exit=${start.code}: ${start.combined.slice(0, 600)}`);
        }

        await sleep(1500);
        const ps = await runSubcommand(['ps']);
        if (ps.code !== 0) throw new Error(`ps exit=${ps.code}: ${ps.combined.slice(0, 400)}`);

        const lines = ps.combined.split('\n');
        const dataLines = lines.filter((l) => /^[a-f0-9]{8,}/.test(l.trim()));
        const hasA = dataLines.some((l) => /ps-a/.test(l));
        const hasB = dataLines.some((l) => /ps-b/.test(l));
        if (!hasA || !hasB) {
          throw new Error(`expected both ps-a and ps-b in ps output: ${ps.combined.slice(0, 800)}`);
        }

        const running = dataLines.filter((l) => /running/.test(l));
        if (running.length < 2) {
          throw new Error(`expected at least 2 running rows; got ${running.length}: ${ps.combined.slice(0, 800)}`);
        }

        await runSubcommand(['stop', 'ps-a', 'ps-b']);
      } finally {
        await stopDaemon();
      }
    });
  },
};
