const fs = require('fs');
const path = require('path');
const {
  sandbox, runSubcommand, startDaemon, stopDaemon, readDaemonState, withEcho, fetchJson,
  waitForTunnelByName, isPidAlive, sleep,
} = require('../lib/framework.cjs');

// 1 daemon and 2 detached tunnels go through what 4 separate cases test: ps-output,
// reconnect-limit, crash-recovery-detached and stop-resolution. Those run in the `full` suite.
// When this case fails, run the one named in the error to narrow it down.
const DEFAULT_LIMIT = 'pair-a';
const SAVED_LIMIT = 'pair-b';
const NAMES = [DEFAULT_LIMIT, SAVED_LIMIT];

function fail(separateCase, message) {
  throw new Error(`[${separateCase}] ${message}`);
}

async function run(separateCase, args, options) {
  const res = await runSubcommand(args, options);
  if (res.code !== 0) fail(separateCase, `${args.join(' ')} exit=${res.code}: ${res.combined.slice(0, 600)}`);
  return res;
}

function savedConfigPath(name) {
  const dir = sandbox.tunnelsConfigDir();
  const file = fs.readdirSync(dir).find((f) => f.startsWith(`${name}_`) && f.endsWith('.json'));
  if (!file) fail('reconnect-limit', `no ${name}_*.json in ${dir}`);
  return path.join(dir, file);
}

// ps never starts a daemon: a new daemon would start every auto-start tunnel.
async function checkPsWithoutDaemon() {
  const ps = await runSubcommand(['ps']);
  if (ps.code !== 0 || !/No active tunnels\. The daemon is not running\./.test(ps.combined)) {
    fail('ps-output', `ps (no daemon) exit=${ps.code}: ${ps.combined.slice(0, 400)}`);
  }
  const status = await runSubcommand(['daemon', 'status']);
  if (!/No daemon is running/i.test(status.combined)) fail('ps-output', `ps started a daemon: ${status.combined.slice(0, 400)}`);
}

async function checkEmptyPs() {
  const ps = await runSubcommand(['ps']);
  if (!/No active tunnels\./.test(ps.combined) || /daemon is not running/.test(ps.combined)) {
    fail('ps-output', `empty ps unexpected output: ${ps.combined.slice(0, 400)}`);
  }
}

// A plain save stores the defaults. The 2nd config carries its own limit, as older app versions wrote.
async function saveConfigs(port) {
  for (const name of NAMES) await run('reconnect-limit', ['config', 'save', name, '-l', String(port)]);
  const saved = JSON.parse(fs.readFileSync(savedConfigPath(DEFAULT_LIMIT), 'utf-8')).tunnelConfig;
  if (saved.autoReconnect !== true || saved.maxReconnectAttempts !== 0) {
    fail('reconnect-limit', `saved defaults wrong: ${JSON.stringify(saved)}`);
  }
  const file = savedConfigPath(SAVED_LIMIT);
  const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
  config.tunnelConfig.maxReconnectAttempts = 3;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

async function runningTunnels(separateCase) {
  const tunnels = [];
  for (const name of NAMES) {
    const tunnel = await waitForTunnelByName(name);
    if (!tunnel) fail(separateCase, `${name} did not reach running state`);
    tunnels.push(tunnel);
  }
  return tunnels;
}

// The daemon forces limit 0 on every tunnel it creates, so the saved 3 does not apply.
async function checkLimits(tunnels) {
  for (const tunnel of tunnels) {
    const { name, autoReconnect, maxReconnectAttempts } = tunnel.tunnelconfig;
    if (autoReconnect !== true || maxReconnectAttempts !== 0) {
      fail('reconnect-limit', `/tunnels ${name}: autoReconnect=${autoReconnect} maxReconnectAttempts=${maxReconnectAttempts}`);
    }
  }
  const url = tunnels[0].remoteurls.find((u) => u.startsWith('https://')) || tunnels[0].remoteurls[0];
  const res = await fetchJson(url);
  if (res.status !== 200) fail('reconnect-limit', `fetch through tunnel returned ${res.status}: ${res.text.slice(0, 300)}`);
}

async function checkPsRows() {
  const ps = await run('ps-output', ['ps']);
  const rows = ps.combined.split('\n').filter((line) => /^[a-f0-9]{8,}/.test(line.trim()));
  for (const name of NAMES) {
    const row = rows.find((line) => line.includes(name));
    if (!row || !/running/.test(row)) fail('ps-output', `expected a running row for ${name}: ${ps.combined.slice(0, 800)}`);
  }
}

async function crashDaemon(pid) {
  const state = readDaemonState();
  const tracked = state && Array.isArray(state.tunnels) ? state.tunnels : [];
  if (tracked.length !== 2 || tracked.some((t) => t.mode !== 'detached')) {
    fail('crash-recovery-detached', `daemon-state.json should track 2 detached tunnels: ${JSON.stringify(state)}`);
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 50 && isPidAlive(pid); i++) await sleep(100);
  if (isPidAlive(pid)) fail('crash-recovery-detached', `daemon PID ${pid} still alive after SIGKILL`);
  if (!fs.existsSync(sandbox.daemonStatePath())) fail('crash-recovery-detached', 'daemon-state.json missing after SIGKILL');
}

async function checkStops(prefixTunnel) {
  const byName = await run('stop-resolution', ['stop', DEFAULT_LIMIT]);
  if (!/stopped/i.test(byName.combined)) fail('stop-resolution', `stop by name: ${byName.combined.slice(0, 400)}`);
  const byPrefix = await run('stop-resolution', ['stop', prefixTunnel.tunnelid.slice(0, 8)]);
  if (!/stopped/i.test(byPrefix.combined)) fail('stop-resolution', `stop by ID prefix: ${byPrefix.combined.slice(0, 400)}`);
  const missing = await runSubcommand(['stop', 'nonexistent-zzz']);
  if (!/No tunnel found/i.test(missing.combined)) {
    fail('stop-resolution', `expected "No tunnel found" message: ${missing.combined.slice(0, 400)}`);
  }
}

module.exports = {
  name: 'detached-pair',
  suite: 'ci',
  async run() {
    sandbox.reset();
    await checkPsWithoutDaemon();
    await withEcho('http', async (echo) => {
      const info = await startDaemon();
      try {
        await checkEmptyPs();
        await saveConfigs(echo.port);
        await Promise.all(NAMES.map((name) => run('ps-output', ['start', name, '-b'], { timeoutMs: 60000 })));
        await checkLimits(await runningTunnels('reconnect-limit'));
        await checkPsRows();

        await crashDaemon(info.pid);
        await startDaemon();
        const restored = await runningTunnels('crash-recovery-detached');
        await checkStops(restored[1]);
      } finally {
        await stopDaemon();
      }
    });
  },
};
