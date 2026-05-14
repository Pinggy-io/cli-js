const http = require('http');

const port = parseInt(process.argv[2] || '0', 10);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    const payload = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      remoteAddr: req.socket.remoteAddress,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`LISTENING ${addr.port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
