const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
} = require('../lib/framework.cjs');

// No daemon and no network: `pinggy logs` and `pinggy log path` read the log directory themselves.
module.exports = {
  name: 'logs-libpinggy',
  async run() {
    sandbox.reset();

    const libLog = path.join(sandbox.pinggyLogDir(), 'libpinggy', 'libpinggy.log');

    const where = await runSubcommand(['log', 'path', 'libpinggy']);
    if (where.code !== 0 || !where.combined.includes(libLog)) {
      throw new Error(`log path libpinggy: exit=${where.code} out=${where.combined.slice(0, 400)}`);
    }

    const missing = await runSubcommand(['logs', 'libpinggy']);
    if (missing.code === 0 || !/Log file not found/i.test(missing.combined)) {
      throw new Error(`logs libpinggy with no file should fail; exit=${missing.code} out=${missing.combined.slice(0, 400)}`);
    }

    fs.mkdirSync(path.dirname(libLog), { recursive: true });
    fs.writeFileSync(libLog, 'native line one\nnative line two\n');
    const shown = await runSubcommand(['logs', 'libpinggy']);
    if (shown.code !== 0 || !shown.combined.includes('native line two')) {
      throw new Error(`logs libpinggy: exit=${shown.code} out=${shown.combined.slice(0, 400)}`);
    }

    // A tunnel called "libpinggy" keeps the name for its own log.
    const tunnelLog = path.join(sandbox.tunnelLogDir(), 'cli__libpinggy.log');
    fs.mkdirSync(path.dirname(tunnelLog), { recursive: true });
    fs.writeFileSync(tunnelLog, 'tunnel line\n');
    const tunnel = await runSubcommand(['log', 'path', 'libpinggy']);
    if (tunnel.code !== 0 || !tunnel.combined.includes(tunnelLog)) {
      throw new Error(`a tunnel named libpinggy should win: exit=${tunnel.code} out=${tunnel.combined.slice(0, 400)}`);
    }
  },
};
