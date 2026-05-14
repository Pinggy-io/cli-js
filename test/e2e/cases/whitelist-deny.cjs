const { withTunnel, withEcho, pickHttpsUrl } = require('../lib/framework.cjs');

const CONNECTION_RESET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

function findResetCode(err) {
  let cur = err;
  while (cur) {
    if (cur.code && CONNECTION_RESET_CODES.has(cur.code)) return cur.code;
    cur = cur.cause;
  }
  return null;
}

function describeError(err) {
  const parts = [];
  let cur = err;
  while (cur) {
    parts.push(`${cur.name || 'Error'}${cur.code ? `(${cur.code})` : ''}: ${cur.message}`);
    cur = cur.cause;
  }
  return parts.join(' <- ');
}

module.exports = {
  name: 'whitelist-deny',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'whitelist-deny', build: { localPort: echo.port, extOpts: ['w:10.0.0.1/32'] } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);

          let res;
          try {
            res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          } catch (err) {
            const code = findResetCode(err);
            if (code) {
              process.stdout.write(`  denial: connection reset (${code})\n`);
              return;
            }
            throw new Error(`whitelist deny expected 403 or connection reset; got error: ${describeError(err)}`);
          }

          // Edge returned an HTTP response. Only 403 counts as a legitimate denial.
          if (res.status === 403) {
            process.stdout.write(`  denial: HTTP 403\n`);
            return;
          }
          throw new Error(`whitelist deny expected status 403 or connection reset; got ${res.status}`);
        }
      )
    );
  },
};
