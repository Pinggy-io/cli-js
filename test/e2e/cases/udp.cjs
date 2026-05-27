const dgram = require('dgram');
const { withTunnel, withEcho, pickProtoUrl, SkipCase, sleep } = require('../lib/framework.cjs');

function udpEcho(host, port, payload) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('udp echo timeout'));
    }, 15000);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      if (msg.equals(payload)) resolve();
      else reject(new Error(`udp echo mismatch: sent ${payload.toString()}, got ${msg.toString()}`));
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.send(payload, port, host, (err) => {
      if (err) { clearTimeout(timer); sock.close(); reject(err); }
    });
  });
}

async function runOnce(echo) {
  await withTunnel(
    { name: 'udp', build: { type: 'udp', localPort: echo.port } },
    async ({ urls }) => {
      const udpUrl = pickProtoUrl(urls, 'udp');
      if (!udpUrl) throw new SkipCase(`no udp:// url; got ${urls.join(',')}`);
      const u = new URL(udpUrl);
      if (!u.port) throw new SkipCase(`udp url has no port: ${udpUrl}`);
      await udpEcho(u.hostname, parseInt(u.port, 10), Buffer.from('hello-udp-e2e'));
    }
  );
}

module.exports = {
  name: 'udp',
  async run() {
    await withEcho('udp', async (echo) => {
      const MAX_ATTEMPTS = 3;
      let lastErr;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await runOnce(echo);
          if (attempt > 1) {
            process.stdout.write(`  udp passed on attempt ${attempt}/${MAX_ATTEMPTS}\n`);
          }
          return;
        } catch (e) {
          if (e && e.skip) throw e;
          lastErr = e;
          process.stdout.write(`  udp attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e && e.message ? e.message : e}\n`);
          if (attempt < MAX_ATTEMPTS) await sleep(2000);
        }
      }
      throw new Error(`udp failed all ${MAX_ATTEMPTS} attempts; last: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
    });
  },
};
