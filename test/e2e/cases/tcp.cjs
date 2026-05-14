const net = require('net');
const { withTunnel, withEcho, pickProtoUrl, SkipCase } = require('../lib/framework.cjs');

function tcpEcho(host, port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 15000 });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('tcp echo timeout'));
    }, 15000);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (d) => {
      chunks.push(d);
      const got = Buffer.concat(chunks);
      if (got.length >= payload.length) {
        clearTimeout(timer);
        socket.end();
        if (got.equals(payload)) resolve();
        else reject(new Error(`tcp echo mismatch: sent ${payload.toString()}, got ${got.toString()}`));
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

module.exports = {
  name: 'tcp',
  async run() {
    await withEcho('tcp', (echo) =>
      withTunnel(
        { name: 'tcp', build: { type: 'tcp', localPort: echo.port } },
        async ({ urls }) => {
          const tcpUrl = pickProtoUrl(urls, 'tcp');
          if (!tcpUrl) throw new SkipCase(`no tcp:// url ; got ${urls.join(',')}`);
          const u = new URL(tcpUrl);
          if (!u.port) throw new SkipCase(`tcp url has no port: ${tcpUrl}`);
          await tcpEcho(u.hostname, parseInt(u.port, 10), Buffer.from('hello-tcp-e2e'));
        }
      )
    );
  },
};
