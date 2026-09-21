const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
  startDaemon,
  stopDaemon,
  withEcho,
  waitForTunnelByName,
  fetchJson,
} = require('../lib/framework.cjs');

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function savedConfigPath(name) {
  const dir = sandbox.tunnelsConfigDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const file = files.find((f) => f.startsWith(`${name}_`) && f.endsWith('.json'));
  if (!file) throw new Error(`no ${name}_*.json in ${dir}: ${files.join(', ')}`);
  return path.join(dir, file);
}

function readSaved(name) {
  return JSON.parse(fs.readFileSync(savedConfigPath(name), 'utf-8'));
}

async function startAndRead(name) {
  const start = await runSubcommand(['start', name, '-b'], { timeoutMs: 60000 });
  if (start.code !== 0) throw new Error(`start ${name} -b exit=${start.code}: ${start.combined.slice(0, 600)}`);
  const t = await waitForTunnelByName(name);
  if (!t) throw new Error(`${name} did not reach running state`);
  return t;
}

// Reconnect defaults: auto-reconnect on, maxReconnectAttempts 0 (retry
// forever). 0 is the value most likely to be lost to a truthiness check
// somewhere between the CLI default, the saved config, the daemon, and the
// SDK, so the case follows it all the way to the running tunnel. It also
// checks that a saved config carrying its own limit is not overwritten by
// the default.
module.exports = {
  name: 'reconnect-limit',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      const port = String(echo.port);
      await startDaemon();
      try {
        // A plain save gets the defaults: autoReconnect true, limit 0.
        const save = await runSubcommand(['config', 'save', 'reconn0', '-l', port]);
        if (save.code !== 0) throw new Error(`config save exit=${save.code}: ${save.combined.slice(0, 600)}`);
        const tc0 = readSaved('reconn0').tunnelConfig;
        eq(tc0.autoReconnect, true, 'saved reconn0 autoReconnect');
        eq(tc0.maxReconnectAttempts, 0, 'saved reconn0 maxReconnectAttempts');

        // A saved config with an explicit limit keeps it.
        const save3 = await runSubcommand(['config', 'save', 'reconn3', '-l', port]);
        if (save3.code !== 0) throw new Error(`config save (reconn3) exit=${save3.code}: ${save3.combined.slice(0, 600)}`);
        const file3 = savedConfigPath('reconn3');
        const cfg3 = JSON.parse(fs.readFileSync(file3, 'utf-8'));
        cfg3.tunnelConfig.maxReconnectAttempts = 3;
        fs.writeFileSync(file3, JSON.stringify(cfg3, null, 2));

        // The values reach the running tunnels: the daemon reports them back
        // exactly, and the default-0 tunnel serves traffic.
        const t0 = await startAndRead('reconn0');
        eq(t0.tunnelconfig.autoReconnect, true, '/tunnels reconn0 autoReconnect');
        eq(t0.tunnelconfig.maxReconnectAttempts, 0, '/tunnels reconn0 maxReconnectAttempts');

        const url = t0.remoteurls.find((u) => u.startsWith('https://')) || t0.remoteurls[0];
        const res = await fetchJson(url);
        if (res.status !== 200) throw new Error(`fetch through tunnel returned ${res.status}: ${res.text.slice(0, 300)}`);

        const t3 = await startAndRead('reconn3');
        eq(t3.tunnelconfig.maxReconnectAttempts, 3, '/tunnels reconn3 maxReconnectAttempts');

        for (const name of ['reconn0', 'reconn3']) {
          const stop = await runSubcommand(['stop', name]);
          if (stop.code !== 0) throw new Error(`stop ${name} exit=${stop.code}: ${stop.combined.slice(0, 400)}`);
        }
      } finally {
        await stopDaemon();
      }
    });
  },
};
