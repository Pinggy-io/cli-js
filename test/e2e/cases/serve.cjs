const fs = require('fs');
const path = require('path');
const { withTunnel, pickHttpsUrl, workDir } = require('../lib/framework.cjs');

module.exports = {
  name: 'serve',
  async run() {
    const siteDir = path.join(workDir, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(
      path.join(siteDir, 'index.html'),
      '<html><body><h1>Pinggy E2E Test</h1></body></html>'
    );

    await withTunnel(
      { name: 'serve', build: { serve: siteDir } },
      async ({ urls }) => {
        const url = pickHttpsUrl(urls);
        if (!url) throw new Error('no HTTPS url returned');
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
        const body = await res.text();
        if (!body.includes('Pinggy E2E Test')) throw new Error('body missing expected content');
      }
    );
  },
};
