const {
  sandbox, runSubcommand, startDaemon, stopDaemon, withEcho, fetchJson, ipcRequest,
  waitForTunnelByName, pickHttpsUrl, sleep,
} = require('../lib/framework.cjs');
const { checkNativeLog } = require('../lib/nativeLog.cjs');

const NAMES = ['native-a', 'native-b'];

// The `ci` suite checks the same in detached-pair.
module.exports = {
  name: 'libpinggy-log',
  suite: 'full',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      try {
        for (const name of NAMES) {
          const save = await runSubcommand(['config', 'save', name, '-l', String(echo.port)]);
          if (save.code !== 0) throw new Error(`config save ${name}: ${save.combined.slice(0, 400)}`);
        }
        const starts = await Promise.all(NAMES.map((name) => runSubcommand(['start', name, '-b'], { timeoutMs: 60000 })));
        const failed = starts.find((res) => res.code !== 0);
        if (failed) throw new Error(`start exit=${failed.code}: ${failed.combined.slice(0, 600)}`);

        const tunnels = [];
        for (const name of NAMES) {
          const tunnel = await waitForTunnelByName(name);
          if (!tunnel) throw new Error(`${name} did not reach running state`);
          tunnels.push(tunnel);
        }

        await checkNativeLog({
          sandbox, ipcRequest, fetchJson, sleep,
          url: pickHttpsUrl(tunnels[0].remoteurls),
          fail: (message) => { throw new Error(message); },
        });
      } finally {
        await stopDaemon();
      }
    });
  },
};
