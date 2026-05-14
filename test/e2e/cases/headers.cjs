const fs = require('fs');
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
        async ({ urls, log }) => {
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
          // x:xff: free-tier Pinggy may not inject the header on the wire, but CLI must
          // pass the option to the SDK. Verify via worker log.
          const logContent = fs.readFileSync(log, 'utf-8');
          if (!/X-Forwarded-For configuration set to:\s*true/i.test(logContent)) {
            throw new Error('CLI did not propagate x:xff to the SDK');
          }
        }
      )
    );
  },
};
