const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  sleep,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'daemon-status',
  async run() {
    sandbox.reset();

    const before = await runSubcommand(['daemon', 'status']);
    if (!/No daemon is running/i.test(before.combined)) {
      throw new Error(`status (no daemon) unexpected output: ${before.combined.slice(0, 400)}`);
    }

    const info = await startDaemon();
    try {
      const s1 = await runSubcommand(['daemon', 'status']);
      if (s1.code !== 0) throw new Error(`status exit=${s1.code}: ${s1.combined.slice(0, 400)}`);
      const pidMatch = s1.combined.match(/PID:\s*(\d+)/);
      const portMatch = s1.combined.match(/Port:\s*(\d+)/);
      const upMatch = s1.combined.match(/Uptime:\s*([^\n]+)/);
      if (!pidMatch || !portMatch || !upMatch) {
        throw new Error(`status output missing fields: ${s1.combined.slice(0, 500)}`);
      }
      if (parseInt(pidMatch[1], 10) !== info.pid) {
        throw new Error(`status pid ${pidMatch[1]} != daemon pid ${info.pid}`);
      }
      if (parseInt(portMatch[1], 10) !== info.port) {
        throw new Error(`status port ${portMatch[1]} != daemon port ${info.port}`);
      }

      await sleep(2000);
      const s2 = await runSubcommand(['daemon', 'status']);
      const up1 = upMatch[1].trim();
      const up2Match = s2.combined.match(/Uptime:\s*([^\n]+)/);
      if (!up2Match) throw new Error(`second status missing uptime: ${s2.combined.slice(0, 400)}`);
      const up2 = up2Match[1].trim();
      if (up1 === up2) {
        throw new Error(`uptime did not change between calls: '${up1}' vs '${up2}'`);
      }
    } finally {
      await stopDaemon();
    }
  },
};
