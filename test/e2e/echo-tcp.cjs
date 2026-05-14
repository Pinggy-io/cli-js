const net = require('net');

const port = parseInt(process.argv[2] || '0', 10);

const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    socket.write(data);
  });
  socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`LISTENING ${addr.port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
