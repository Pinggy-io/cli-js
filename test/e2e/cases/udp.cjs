const dgram = require('dgram');
const { withTunnel, withEcho, pickProtoUrl, SkipCase } = require('../lib/framework.cjs');

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

module.exports = {
  name: 'udp',
  async run() {
    await withEcho('udp', (echo) =>
      withTunnel(
        { name: 'udp', build: { type: 'udp', localPort: echo.port } },
        async ({ urls }) => {
          const udpUrl = pickProtoUrl(urls, 'udp');
          if (!udpUrl) throw new SkipCase(`no udp:// url; got ${urls.join(',')}`);
          const u = new URL(udpUrl);
          if (!u.port) throw new SkipCase(`udp url has no port: ${udpUrl}`);
          await udpEcho(u.hostname, parseInt(u.port, 10), Buffer.from('hello-udp-e2e'));
        }
      )
    );
  },
};
