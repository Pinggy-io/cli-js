const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  ipcRequest,
  withEcho,
  sleep,
} = require('../lib/framework.cjs');

async function startNamed(name, port) {
  const save = await runSubcommand(['config', 'save', name, '-l', String(port)]);
  if (save.code !== 0) throw new Error(`save ${name} failed: ${save.combined.slice(0, 400)}`);
  const start = await runSubcommand(['start', name, '-b'], { timeoutMs: 60000 });
  if (start.code !== 0) throw new Error(`start ${name} exit=${start.code}: ${start.combined.slice(0, 600)}`);
}

async function tunnelIdForName(name) {
  const list = await ipcRequest('GET', '/tunnels');
  if (list.status !== 200 || !Array.isArray(list.json)) {
    throw new Error(`/tunnels failed: status=${list.status}`);
  }
  const match = list.json.find((t) => (t.tunnelconfig && t.tunnelconfig.name) === name);
  if (!match) throw new Error(`no tunnel matching name ${name} in ipc list`);
  return match.tunnelid;
}

module.exports = {
  name: 'stop-resolution',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      try {
        await startNamed('stp-name', echo.port);
        const stopByName = await runSubcommand(['stop', 'stp-name']);
        if (stopByName.code !== 0) throw new Error(`stop by name exit=${stopByName.code}: ${stopByName.combined.slice(0, 400)}`);
        if (!/stopped/i.test(stopByName.combined)) throw new Error(`expected stopped message: ${stopByName.combined.slice(0, 400)}`);

        await runSubcommand(['config', 'delete', 'stp-name']);
        await startNamed('stp-id', echo.port);
        const tunnelId = await tunnelIdForName('stp-id');
        const prefix = tunnelId.slice(0, 8);

        const stopByPrefix = await runSubcommand(['stop', prefix]);
        if (stopByPrefix.code !== 0) throw new Error(`stop by id-prefix exit=${stopByPrefix.code}: ${stopByPrefix.combined.slice(0, 400)}`);
        if (!/stopped/i.test(stopByPrefix.combined)) throw new Error(`expected stopped message: ${stopByPrefix.combined.slice(0, 400)}`);

        const stopMissing = await runSubcommand(['stop', 'nonexistent-zzz']);
        if (!/No tunnel found/i.test(stopMissing.combined)) {
          throw new Error(`expected "No tunnel found" message: ${stopMissing.combined.slice(0, 400)}`);
        }

        await sleep(500);
      } finally {
        await stopDaemon();
      }
    });
  },
};
