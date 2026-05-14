const { withTunnel, withEcho, pickHttpsUrl } = require('../lib/framework.cjs');

module.exports = {
  name: 'bearer-auth',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'bearer-auth', build: { localPort: echo.port, extOpts: ['k:tk_test_abc123'] } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);

          const noHdr = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (noHdr.status !== 401) throw new Error(`without bearer expected 401, got ${noHdr.status}`);

          const good = await fetch(url, {
            headers: { Authorization: 'Bearer tk_test_abc123' },
            signal: AbortSignal.timeout(30000),
          });
          if (good.status !== 200) throw new Error(`with bearer expected 200, got ${good.status}`);
        }
      )
    );
  },
};
