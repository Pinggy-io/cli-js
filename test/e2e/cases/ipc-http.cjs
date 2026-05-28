const {
  sandbox,
  startDaemon,
  stopDaemon,
  ipcRequest,
  readDaemonInfo,
  waitForDaemonGone,
  isPidAlive,
  sleep,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'ipc-http',
  async run() {
    sandbox.reset();
    const info = await startDaemon();
    let manuallyStopped = false;
    try {
      const ping = await ipcRequest('GET', '/ping');
      if (ping.status !== 200) throw new Error(`/ping status=${ping.status}`);
      if (!ping.json || ping.json.status !== 'ok' || typeof ping.json.uptime !== 'number' || ping.json.pid !== info.pid) {
        throw new Error(`/ping body unexpected: ${ping.text.slice(0, 300)}`);
      }

      const list = await ipcRequest('GET', '/tunnels');
      if (list.status !== 200) throw new Error(`/tunnels status=${list.status}`);
      if (!Array.isArray(list.json) || list.json.length !== 0) {
        throw new Error(`/tunnels should be empty array: ${list.text.slice(0, 300)}`);
      }

      const tunnelLogging = await ipcRequest('GET', '/config/tunnel-logging');
      if (tunnelLogging.status !== 200 || typeof tunnelLogging.json.enabled !== 'boolean') {
        throw new Error(`/config/tunnel-logging unexpected: ${tunnelLogging.text.slice(0, 300)}`);
      }

      const logPaths = await ipcRequest('GET', '/logs/paths');
      if (logPaths.status !== 200 || typeof logPaths.json.daemon !== 'string') {
        throw new Error(`/logs/paths unexpected: ${logPaths.text.slice(0, 300)}`);
      }

      const shutdown = await ipcRequest('POST', '/shutdown', {});
      if (shutdown.status !== 200) throw new Error(`/shutdown status=${shutdown.status}`);
      if (!shutdown.json || shutdown.json.status !== 'shutting_down') {
        throw new Error(`/shutdown body unexpected: ${shutdown.text.slice(0, 300)}`);
      }
      manuallyStopped = true;

      const exited = await waitForDaemonGone(8000);
      if (!exited) {
        throw new Error(`daemon did not exit after /shutdown (PID ${info.pid} alive=${isPidAlive(info.pid)})`);
      }

      if (readDaemonInfo() !== null) {
        throw new Error(`daemon.json still present after /shutdown`);
      }
    } finally {
      if (!manuallyStopped) await stopDaemon();
      await sleep(200);
    }
  },
};
