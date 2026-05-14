const fs = require('fs');
const path = require('path');
const { withTunnel, withEcho, pickHttpsUrl, workDir } = require('../lib/framework.cjs');

module.exports = {
  name: 'config-roundtrip',
  async run() {
    const cfgPath = path.join(workDir, 'tunnel-cfg.json');
    await withEcho('http', async (echo) => {
      await withTunnel(
        { name: 'saveconf', build: { localPort: echo.port, extraFlags: ['--saveconf', cfgPath] } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (res.status !== 200) throw new Error(`saveconf run: expected 200, got ${res.status}`);
          if (!fs.existsSync(cfgPath)) throw new Error('config file not written');
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (!cfg || typeof cfg !== 'object') throw new Error('config file empty');
        }
      );

      await withTunnel(
        { name: 'loadconf', build: { confFile: cfgPath, omitServer: true } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (res.status !== 200) throw new Error(`loadconf run: expected 200, got ${res.status}`);
        }
      );
    });
  },
};
