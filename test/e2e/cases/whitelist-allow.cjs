const { withTunnel, withEcho, pickHttpsUrl, getPublicIp, SkipCase } = require('../lib/framework.cjs');

module.exports = {
  name: 'whitelist-allow',
  async run() {
    const ip = getPublicIp();
    if (!ip) throw new SkipCase('public IP not yet parsed from a tunnel URL');
    const cidr = `${ip}/32`;
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'whitelist-allow', build: { localPort: echo.port, extOpts: [`w:${cidr}`] } },
        async ({ urls }) => {
          process.stdout.write(`  whitelist: ${cidr}\n`);
          const url = pickHttpsUrl(urls);
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (res.status !== 200) throw new Error(`expected 200 for whitelist ${cidr}, got ${res.status}`);
        }
      )
    );
  },
};
