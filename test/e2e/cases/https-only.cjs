const { withTunnel, withEcho, pickHttpsUrl, pickHttpUrl } = require('../lib/framework.cjs');

module.exports = {
  name: 'https-only',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'https-only', build: { localPort: echo.port, extOpts: ['x:https'] } },
        async ({ urls }) => {
          const httpsUrl = pickHttpsUrl(urls);
          const httpUrl = pickHttpUrl(urls);
          if (!httpUrl) throw new Error('no http url to test against');

          const httpRes = await fetch(httpUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
          });
          if (httpRes.status === 200) {
            throw new Error('http url returned 200, expected redirect/reject under x:https');
          }

          const httpsRes = await fetch(httpsUrl, { signal: AbortSignal.timeout(30000) });
          if (httpsRes.status !== 200) {
            throw new Error(`https url expected 200, got ${httpsRes.status}`);
          }
        }
      )
    );
  },
};
