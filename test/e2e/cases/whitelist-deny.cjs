const { withTunnel, withEcho, pickHttpsUrl } = require('../lib/framework.cjs');

module.exports = {
  name: 'whitelist-deny',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'whitelist-deny', build: { localPort: echo.port, extOpts: ['w:10.0.0.1/32'] } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);
          let status = null;
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
            status = res.status;
          } catch {
            // connection-level rejection is also a valid form of denial
            return;
          }
          if (status === 200) throw new Error('expected denial, got 200');
        }
      )
    );
  },
};
