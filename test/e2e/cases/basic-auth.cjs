const { withTunnel, withEcho, pickHttpsUrl } = require('../lib/framework.cjs');

module.exports = {
  name: 'basic-auth',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'basic-auth', build: { localPort: echo.port, extOpts: ['b:alice:s3cret'] } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);

          const noCreds = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (noCreds.status !== 401) throw new Error(`without creds expected 401, got ${noCreds.status}`);

          const wrong = await fetch(url, {
            headers: { Authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64') },
            signal: AbortSignal.timeout(30000),
          });
          if (wrong.status !== 401) throw new Error(`wrong creds expected 401, got ${wrong.status}`);

          const right = await fetch(url, {
            headers: { Authorization: 'Basic ' + Buffer.from('alice:s3cret').toString('base64') },
            signal: AbortSignal.timeout(30000),
          });
          if (right.status !== 200) throw new Error(`correct creds expected 200, got ${right.status}`);
        }
      )
    );
  },
};
