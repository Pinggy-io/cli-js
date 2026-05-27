const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
  stopDaemon,
} = require('../lib/framework.cjs');

function pickStalePid() {
  for (const candidate of [999999, 888888, 777777]) {
    try { process.kill(candidate, 0); } catch { return candidate; }
  }
  return 999999;
}

module.exports = {
  name: 'daemon-stale-pid',
  async run() {
    sandbox.reset();

    const stalePid = pickStalePid();
    const dir = path.dirname(sandbox.daemonJsonPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sandbox.daemonJsonPath(),
      JSON.stringify({ pid: stalePid, port: 1, startedAt: new Date().toISOString() }),
      'utf-8'
    );

    try {
      const res = await runSubcommand(['daemon', 'status']);
      if (!/No daemon is running/i.test(res.combined)) {
        throw new Error(`expected stale daemon.json to be cleaned and reported absent; got: ${res.combined.slice(0, 400)}`);
      }
      if (fs.existsSync(sandbox.daemonJsonPath())) {
        throw new Error('stale daemon.json was not removed after daemon status');
      }
    } finally {
      await stopDaemon();
    }
  },
};
