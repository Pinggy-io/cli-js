const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sleep,
  waitForTunnel,
  killProc,
  spawnCli,
  dumpLogs,
  startEchoServer,
  stopEchoServer,
  setExtraEnv,
} = require('./cli.cjs');
const { createSandbox } = require('./sandbox.cjs');
const daemon = require('./daemon.cjs');

const SERVER = 'free.pinggy.io';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinggy-e2e-'));

const sandbox = createSandbox(workDir);
setExtraEnv(sandbox.env);

let dbgPortCounter = 4300;
function nextDbgPort() { return dbgPortCounter++; }

let binaryPath = null;
function setBinary(p) { binaryPath = p; }

const echoScripts = {
  http: path.join(__dirname, '..', 'echo-http.cjs'),
  tcp: path.join(__dirname, '..', 'echo-tcp.cjs'),
  udp: path.join(__dirname, '..', 'echo-udp.cjs'),
};

let publicIp = null;
function captureIp(urls) {
  if (publicIp) return;
  for (const u of urls) {
    const m = u.match(/-(\d+-\d+-\d+-\d+)\.run\.pinggy-free\.link/);
    if (m) { publicIp = m[1].replace(/-/g, '.'); return; }
  }
}
function getPublicIp() { return publicIp; }

const results = [];
function getResults() { return results; }

class SkipCase extends Error {
  constructor(msg) { super(msg); this.skip = true; }
}

async function runCase(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n>>> CASE ${name}\n`);
  try {
    await fn();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`<<< PASS ${name} (${dt}s)\n`);
    results.push({ name, status: 'PASS' });
  } catch (err) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (err && err.skip) {
      process.stdout.write(`<<< SKIP ${name} (${dt}s): ${err.message}\n`);
      results.push({ name, status: 'SKIP' });
      return;
    }
    process.stdout.write(`<<< FAIL ${name} (${dt}s): ${err && err.message ? err.message : err}\n`);
    results.push({ name, status: 'FAIL', err });
    throw err;
  }
}

function buildArgs({ type = 'http', localPort, dbg, serve, extOpts = [], extraFlags = [], confFile, omitServer = false }) {
  const args = ['--noTui', '--vvv'];
  if (serve) args.push('--serve', serve);
  if (localPort != null) args.push(`-R0:localhost:${localPort}`);
  args.push(`-L${dbg}:localhost:${dbg}`);
  args.push(...extraFlags);
  if (confFile) args.push('--conf', confFile);
  if (!omitServer) args.push(type === 'http' ? SERVER : `${type}@${SERVER}`);
  args.push(...extOpts);
  return args;
}

function logFileFor(name) {
  return path.join(workDir, `tunnel-${name}.log`);
}

async function withTunnel({ name, build }, fn) {
  if (!binaryPath) throw new Error('binaryPath not set (call setBinary first)');
  const dbg = nextDbgPort();
  const log = logFileFor(name);
  const fullArgs = buildArgs({ ...build, dbg });
  process.stdout.write(`  args: ${fullArgs.join(' ')}\n`);
  const proc = spawnCli(binaryPath, fullArgs, { logFile: log });
  try {
    const urls = await waitForTunnel({ logFile: log, debuggerPort: dbg });
    if (!urls) {
      dumpLogs(log);
      throw new Error('tunnel did not come up within timeout');
    }
    process.stdout.write(`  urls: ${urls.join(', ')}\n`);
    captureIp(urls);
    await sleep(2000);
    await fn({ urls, dbg, log });
  } catch (err) {
    dumpLogs(log);
    throw err;
  } finally {
    killProc(proc);
    await sleep(500);
  }
}

async function withEcho(kind, fn) {
  const echo = await startEchoServer(echoScripts[kind]);
  try { return await fn(echo); } finally { stopEchoServer(echo); }
}

function pickHttpsUrl(urls) {
  return urls.find((u) => u.startsWith('https://')) || urls.find((u) => u.startsWith('http://'));
}
function pickHttpUrl(urls) {
  return urls.find((u) => u.startsWith('http://') && !u.startsWith('https://'));
}
function pickProtoUrl(urls, proto) {
  return urls.find((u) => u.startsWith(proto + '://'));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

function getBinary() {
  if (!binaryPath) throw new Error('binaryPath not set (call setBinary first)');
  return binaryPath;
}

module.exports = {
  SERVER,
  workDir,
  sandbox,
  sleep,
  setBinary,
  getBinary,
  getPublicIp,
  SkipCase,
  runCase,
  getResults,
  withTunnel,
  withEcho,
  pickHttpsUrl,
  pickHttpUrl,
  pickProtoUrl,
  fetchJson,
  runSubcommand: (args, opts) => daemon.runSubcommand(getBinary(), args, opts),
  startDaemon: () => daemon.startDaemon(getBinary(), sandbox),
  stopDaemon: (opts) => daemon.stopDaemon(getBinary(), sandbox, opts),
  withDaemon: (fn) => daemon.withDaemon(getBinary(), sandbox, fn),
  readDaemonInfo: () => daemon.readDaemonInfo(sandbox),
  readDaemonState: () => daemon.readDaemonState(sandbox),
  readDaemonConfig: () => daemon.readDaemonConfig(sandbox),
  waitForDaemonInfo: (maxMs) => daemon.waitForDaemonInfo(sandbox, maxMs),
  waitForDaemonGone: (maxMs) => daemon.waitForDaemonGone(sandbox, maxMs),
  ipcRequest: (method, route, body) => daemon.ipcRequest(sandbox, method, route, body),
  isPidAlive: daemon.isPidAlive,
  stripAnsi: daemon.stripAnsi,
};
