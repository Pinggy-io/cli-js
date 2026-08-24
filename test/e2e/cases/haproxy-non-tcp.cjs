const { SERVER, runSubcommand } = require('../lib/framework.cjs');

// x:haproxy is TCP-only. Every other tunnel type must be rejected up front,
// before a daemon is spawned or a tunnel is attempted.
const TYPES = ['http', 'udp', 'tls', 'tlstcp'];

module.exports = {
  name: 'haproxy-non-tcp',
  async run() {
    for (const type of TYPES) {
      const args = [
        '--noTui',
        '--vvv',
        '-R0:localhost:8000',
        type === 'http' ? SERVER : `${type}@${SERVER}`,
        'x:haproxy:v1',
      ];
      process.stdout.write(`  args: ${args.join(' ')}\n`);
      const res = await runSubcommand(args, { timeoutMs: 30000 });

      if (res.timedOut) {
        throw new Error(`${type}: CLI did not exit; x:haproxy:v1 should be rejected immediately`);
      }
      if (res.code === 0) {
        throw new Error(`${type}: expected nonzero exit for x:haproxy:v1, got 0\n${res.combined}`);
      }
      if (!/can only be used with TCP tunnels/i.test(res.combined)) {
        throw new Error(`${type}: missing HAProxy validation error, got:\n${res.combined}`);
      }
      if (!new RegExp(`"${type}"`).test(res.combined)) {
        throw new Error(`${type}: error did not name the tunnel type, got:\n${res.combined}`);
      }
      process.stdout.write(`  ${type}: rejected (exit ${res.code})\n`);
    }
  },
};
