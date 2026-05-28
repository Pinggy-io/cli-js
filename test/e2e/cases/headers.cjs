const { withTunnel, withEcho, pickHttpsUrl, fetchJson } = require('../lib/framework.cjs');

module.exports = {
  name: 'headers',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        {
          name: 'headers',
          build: {
            localPort: echo.port,
            extOpts: [
              'a:X-E2E-Add:hello',
              'u:User-Agent:e2e-runner',
              'r:Cookie',
              'x:xff',
            ],
          },
        },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);
          const { status, json } = await fetchJson(url, {
            headers: {
              'User-Agent': 'original-ua',
              'Cookie': 'should-be-removed=1',
              'X-Keep-Me': 'still-here',
            },
          });
          if (status !== 200) throw new Error(`expected 200, got ${status}`);
          if (!json) throw new Error('echo did not return JSON');
          const h = json.headers || {};
          const hDump = () => `received headers: ${JSON.stringify(h)}`;
          if (h['x-e2e-add'] !== 'hello') throw new Error(`x-e2e-add missing/wrong: ${h['x-e2e-add']}. ${hDump()}`);
          if (h['user-agent'] !== 'e2e-runner') throw new Error(`user-agent not updated: ${h['user-agent']}. ${hDump()}`);
          if (h['cookie']) throw new Error(`cookie should have been removed, got: ${h['cookie']}. ${hDump()}`);
          if (h['x-keep-me'] !== 'still-here') throw new Error(`passthrough header lost. ${hDump()}`);
          if (!h['x-forwarded-for']) {
            throw new Error(`x-forwarded-for not injected by tunnel edge despite x:xff. ${hDump()}`);
          }
        }
      )
    );
  },
};
