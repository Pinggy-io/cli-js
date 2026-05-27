const {
  sandbox,
  startDaemon,
  stopDaemon,
  ipcRequest,
  readDaemonConfig,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'ipc-loglevel',
  async run() {
    sandbox.reset();

    await startDaemon();
    let okToStop = true;
    try {
      const initial = await ipcRequest('GET', '/loglevel');
      if (initial.status !== 200 || !['debug', 'info', 'error'].includes(initial.json.level)) {
        throw new Error(`/loglevel initial: ${initial.text.slice(0, 300)}`);
      }

      const set = await ipcRequest('POST', '/loglevel', { level: 'debug' });
      if (set.status !== 200 || set.json.level !== 'debug') {
        throw new Error(`POST /loglevel debug: status=${set.status} body=${set.text.slice(0, 300)}`);
      }

      const after = await ipcRequest('GET', '/loglevel');
      if (after.json.level !== 'debug') {
        throw new Error(`level not persisted in memory: ${after.text.slice(0, 300)}`);
      }

      const cfg = readDaemonConfig();
      if (!cfg || cfg.logLevel !== 'debug') {
        throw new Error(`daemon-config.json missing logLevel=debug; got ${JSON.stringify(cfg)}`);
      }

      await stopDaemon();
      okToStop = false;

      await startDaemon();
      okToStop = true;
      const restored = await ipcRequest('GET', '/loglevel');
      if (restored.json.level !== 'debug') {
        throw new Error(`log level not restored after restart: ${restored.text.slice(0, 300)}`);
      }

      const reset = await ipcRequest('POST', '/loglevel', { level: 'info' });
      if (reset.json.level !== 'info') {
        throw new Error(`reset to info failed: ${reset.text.slice(0, 300)}`);
      }
    } finally {
      if (okToStop) await stopDaemon();
    }
  },
};
