const fs = require('fs');
const {
  sandbox, runSubcommand, startDaemon, stopDaemon, ipcRequest, readDaemonState, withEcho, fetchJson,
  waitForTunnelByName, sleep,
} = require('../lib/framework.cjs');

// 1 daemon and 1 detached tunnel go through what 4 separate cases test: start-background,
// detached-survives-cli-exit, restart and clean-shutdown-clears-state. Those run in the `full`
// suite. When this case fails, run the one named in the error to narrow it down.
const NAME = 'lifecfg';
const GRACE_MS = 5000;
const PAST_GRACE_MS = GRACE_MS + 3000;

function fail(separateCase, message) {
  throw new Error(`[${separateCase}] ${message}`);
}

async function run(separateCase, args, options) {
  const res = await runSubcommand(args, options);
  if (res.code !== 0) fail(separateCase, `${args.join(' ')} exit=${res.code}: ${res.combined.slice(0, 600)}`);
  return res;
}

function httpsUrl(urls) {
  return urls.find((u) => u.startsWith('https://'));
}

async function expectEcho(separateCase, url) {
  const res = await fetchJson(url);
  if (res.status !== 200 || !res.json || res.json.method !== 'GET') {
    fail(separateCase, `fetch ${url} returned ${res.status}: ${res.text.slice(0, 300)}`);
  }
}

function trackedInState() {
  const state = readDaemonState();
  return state && Array.isArray(state.tunnels) ? state.tunnels.find((t) => t.name === NAME) : null;
}

async function listedTunnel() {
  const list = await ipcRequest('GET', '/tunnels');
  return Array.isArray(list.json) ? list.json.find((t) => t.tunnelconfig && t.tunnelconfig.name === NAME) : null;
}

async function psRow() {
  const ps = await runSubcommand(['ps']);
  return ps.combined.split('\n').find((line) => line.includes(NAME));
}

async function startDetached(port) {
  await run('start-background', ['config', 'save', NAME, '-l', String(port)]);
  const start = await run('start-background', ['start', NAME, '-b'], { timeoutMs: 60000 });
  if (!/Success.*lifecfg.*started|started.*ID/i.test(start.combined)) {
    fail('start-background', `expected start success message: ${start.combined.slice(0, 600)}`);
  }
  const url = (start.combined.match(/https:\/\/\S+/) || [])[0];
  if (!url) fail('start-background', `no https URL in start output: ${start.combined.slice(0, 600)}`);
  return url;
}

async function checkDetached() {
  const tracked = trackedInState();
  if (!tracked || tracked.mode !== 'detached') {
    fail('detached-survives-cli-exit', `daemon-state.json should track it as detached: ${JSON.stringify(tracked)}`);
  }
  const listed = await listedTunnel();
  if (!listed || listed.mode !== 'detached') {
    fail('detached-survives-cli-exit', `/tunnels should list it as detached: ${JSON.stringify(listed && listed.mode)}`);
  }
  if (!(await psRow())) fail('start-background', 'ps did not list the tunnel');
  return listed.tunnelconfig.configId;
}

async function restart(configIdBefore) {
  const res = await run('restart', ['restart', NAME], { timeoutMs: 60000 });
  if (!/restarting/i.test(res.combined)) fail('restart', `expected restarting message: ${res.combined.slice(0, 400)}`);
  const after = await waitForTunnelByName(NAME, { maxMs: 30000 });
  if (!after) fail('restart', 'the tunnel did not return to running after restart');
  if (after.tunnelconfig.configId !== configIdBefore) {
    fail('restart', `configId changed: ${configIdBefore} -> ${after.tunnelconfig.configId}`);
  }
  const url = httpsUrl(after.remoteurls);
  if (!url) fail('restart', `no https URL after restart: ${JSON.stringify(after.remoteurls)}`);
  return url;
}

// No CLI holds the tunnel, so a foreground tunnel would be gone by now.
async function checkSurvivesGrace(startedAtMillis, url) {
  const remaining = startedAtMillis + PAST_GRACE_MS - Date.now();
  if (remaining > 0) await sleep(remaining);
  const listed = await listedTunnel();
  if (!listed || !listed.status || listed.status.state !== 'running') {
    fail('detached-survives-cli-exit', `not running past the grace window: ${JSON.stringify(listed && listed.status)}`);
  }
  await expectEcho('detached-survives-cli-exit', url);
}

async function stopTunnel() {
  const stop = await run('start-background', ['stop', NAME]);
  if (!/stopped/i.test(stop.combined)) fail('start-background', `expected stop confirmation: ${stop.combined.slice(0, 400)}`);
  await sleep(500);
  const row = await psRow();
  if (row && /running/.test(row)) fail('start-background', `still "running" after stop: ${row}`);
  const state = readDaemonState();
  if (!state || state.tunnels.length !== 0) {
    fail('clean-shutdown-clears-state', `expected empty tunnels after stop; got ${JSON.stringify(state)}`);
  }
}

module.exports = {
  name: 'detached-lifecycle',
  suite: 'ci',
  async run() {
    sandbox.reset();
    await withEcho('http', async (echo) => {
      await startDaemon();
      try {
        const url = await startDetached(echo.port);
        const startedAtMillis = Date.now();
        await expectEcho('start-background', url);
        const configId = await checkDetached();
        const urlAfterRestart = await restart(configId);
        await expectEcho('restart', urlAfterRestart);
        await checkSurvivesGrace(startedAtMillis, urlAfterRestart);
        await stopTunnel();
      } finally {
        await stopDaemon();
      }
      if (fs.existsSync(sandbox.daemonStatePath())) {
        fail('clean-shutdown-clears-state', 'daemon-state.json should be removed on clean shutdown');
      }
    });
  },
};
