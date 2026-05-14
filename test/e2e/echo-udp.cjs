const dgram = require('dgram');

const port = parseInt(process.argv[2] || '0', 10);

const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  server.send(msg, rinfo.port, rinfo.address);
});

server.on('listening', () => {
  const addr = server.address();
  process.stdout.write(`LISTENING ${addr.port}\n`);
});

server.bind(port, '127.0.0.1');

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
