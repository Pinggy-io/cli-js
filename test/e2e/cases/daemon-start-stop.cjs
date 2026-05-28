const fs = require('fs');
const {
  sandbox,
  startDaemon,
  stopDaemon,
  readDaemonInfo,
  ipcRequest,
  isPidAlive,
  sleep,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'daemon-start-stop',
  async run() {
    sandbox.reset();

    const info = await startDaemon();
    if (!info || !info.pid || !info.port) {
      throw new Error(`daemon start did not return valid info: ${JSON.stringify(info)}`);
    }

    const onDisk = readDaemonInfo();
    if (!onDisk || onDisk.pid !== info.pid || onDisk.port !== info.port) {
      throw new Error(`daemon.json content mismatch: ${JSON.stringify(onDisk)} vs ${JSON.stringify(info)}`);
    }

    if (!isPidAlive(info.pid)) {
      throw new Error(`daemon PID ${info.pid} is not alive after start`);
    }

    const ping = await ipcRequest('GET', '/ping');
    if (ping.status !== 200 || !ping.json || ping.json.pid !== info.pid) {
      throw new Error(`ping mismatch: status=${ping.status} body=${ping.text.slice(0, 200)}`);
    }

    const stop = await stopDaemon();
    if (!stop.ok) {
      throw new Error(`daemon stop did not succeed: ${JSON.stringify(stop)}`);
    }

    if (fs.existsSync(sandbox.daemonJsonPath())) {
      throw new Error(`daemon.json still exists after stop`);
    }

    let stillAlive = false;
    for (let i = 0; i < 30; i++) {
      if (!isPidAlive(info.pid)) break;
      await sleep(100);
      if (i === 29) stillAlive = true;
    }
    if (stillAlive) {
      throw new Error(`daemon PID ${info.pid} still alive 3s after stop`);
    }
  },
};
