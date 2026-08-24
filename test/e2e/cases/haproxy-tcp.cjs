const net = require('net');
const { withTunnel, withEcho, pickProtoUrl, getPublicIp, SkipCase } = require('../lib/framework.cjs');

// The tcp echo backend mirrors every byte it receives, so the PROXY protocol
// header libpinggy prepends to the local connection comes straight back to us.
// That is exactly what we want to assert on: what the local server was sent.
function readFirstLine(host, port, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for data; got ${JSON.stringify(buf.toString('latin1'))}`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n');
      if (idx !== -1) {
        clearTimeout(timer);
        socket.end();
        resolve(buf.subarray(0, idx).toString('latin1'));
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

module.exports = {
  name: 'haproxy-tcp',
  async run() {
    // Matching the PROXY header against the runner's public IP is the point of
    // this case, so skip rather than pass weakly when the IP is not known yet.
    const ip = getPublicIp();
    if (!ip) throw new SkipCase('public IP not yet parsed from a tunnel URL');

    await withEcho('tcp', (echo) =>
      withTunnel(
        { name: 'haproxy-tcp', build: { type: 'tcp', localPort: echo.port, extOpts: ['x:haproxy:v1'] } },
        async ({ urls }) => {
          const tcpUrl = pickProtoUrl(urls, 'tcp');
          if (!tcpUrl) throw new SkipCase(`no tcp:// url ; got ${urls.join(',')}`);
          const u = new URL(tcpUrl);
          if (!u.port) throw new SkipCase(`tcp url has no port: ${tcpUrl}`);

          const line = await readFirstLine(u.hostname, parseInt(u.port, 10), Buffer.from('hello-haproxy-e2e'));
          process.stdout.write(`  proxy header: ${JSON.stringify(line)}\n`);

          // PROXY TCP4 <srcIp> <dstIp> <srcPort> <dstPort>
          const m = /^PROXY (TCP4|TCP6|UNKNOWN) (\S+) (\S+) (\d+) (\d+)$/.exec(line);
          if (!m) {
            throw new Error(`local server did not receive a PROXY v1 header; first line: ${JSON.stringify(line)}`);
          }

          const [, family, srcIp, , srcPort] = m;
          if (family === 'UNKNOWN') throw new Error(`PROXY header has UNKNOWN family: ${line}`);
          if (!(parseInt(srcPort, 10) > 0)) throw new Error(`PROXY header has no source port: ${line}`);

          // The client of the tunnel is this runner, so the address the PROXY
          // header reports must be the runner's own public IP.
          if (family === 'TCP6') {
            process.stdout.write(`  note: header is TCP6 (${srcIp}), skipping IPv4 match against ${ip}\n`);
            return;
          }
          if (srcIp !== ip) {
            throw new Error(`PROXY header source IP ${srcIp} does not match runner public IP ${ip}`);
          }
          process.stdout.write(`  client ip matched: ${srcIp}\n`);
        }
      )
    );
  },
};
