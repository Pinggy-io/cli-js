const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { buildEnv, sleep } = require('./cli.cjs');
const { stripAnsi } = require('./daemon.cjs');

const isWindows = process.platform === 'win32';
const VERSION_LINE = /Pinggy CLI version: (\d+\.\d+\.\d+)/;

function runBinary(binaryPath, args, env) {
  const result = spawnSync(binaryPath, args, { env: buildEnv(env), encoding: 'utf-8', timeout: 60000, windowsHide: true });
  const stdout = stripAnsi(result.stdout || '');
  const stderr = stripAnsi(result.stderr || '');
  return { code: result.status, stdout, stderr, combined: stdout + stderr };
}

/** For a command that talks to the fake release server, which runs in this process and needs its event loop free. */
function runBinaryAsync(binaryPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { env: buildEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), combined: stripAnsi(stdout + stderr) });
    });
  });
}

function binaryVersion(binaryPath, env) {
  const match = VERSION_LINE.exec(runBinary(binaryPath, ['--version'], env).stdout);
  if (!match) throw new Error(`${binaryPath} reported no version`);
  return match[1];
}

/** False while a start fails, which can happen in the few milliseconds of a swap. */
function reportsVersion(binaryPath, version) {
  try {
    return binaryVersion(binaryPath) === version;
  } catch {
    return false;
  }
}

function bumpPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** npm installs node-pty's macOS spawn-helper without the execute bit, and every spawn fails without it. */
function makeSpawnHelperExecutable() {
  const prebuilds = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
  for (const platform of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}

/** Runs under a pseudo-terminal, because the background update only starts when stdout is a terminal. */
function runUnderTerminal(binaryPath, args, env, { timeoutMs = 30000 } = {}) {
  makeSpawnHelperExecutable();
  const pty = require('node-pty');
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const terminal = pty.spawn(binaryPath, args, { name: 'xterm', cols: 160, rows: 40, env: buildEnv(env) });
    let output = '';
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error(`${args.join(' ')} did not exit within ${timeoutMs} ms. Output: ${output}`));
    }, timeoutMs);
    terminal.onData((chunk) => { output += chunk; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ code: exitCode, output: stripAnsi(output), elapsedMs: Date.now() - startedAt });
    });
  });
}

async function waitFor(predicate, { maxMs = 120000, pollMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(pollMs);
  }
  throw new Error(`${what} did not happen within ${maxMs} ms`);
}

function startFakeReleases() {
  const files = new Map();
  let latestTag = null;
  let hang = false;

  const server = http.createServer((request, response) => {
    if (hang) return;
    if (request.url === '/releases/latest') {
      if (latestTag === null) response.writeHead(200);
      else response.writeHead(302, { Location: `${api.releasesUrl}/tag/${latestTag}` });
      response.end();
      return;
    }
    const body = files.get(request.url);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });

  const api = {
    releasesUrl: '',
    setLatest: (tag) => { latestTag = tag; },
    setHang: (value) => { hang = value; },
    dropConnections: () => server.closeAllConnections(),
    setFile: (tag, name, body) => { files.set(`/releases/download/${tag}/${name}`, body); },
    /** Offers a binary the way a finished release does: the asset, then SHA256SUMS. */
    publish(tag, assetName, binaryPath) {
      const binary = fs.readFileSync(binaryPath);
      const hash = crypto.createHash('sha256').update(binary).digest('hex');
      const sums = Buffer.from(`${hash}  ${assetName}\n`);
      api.setFile(tag, assetName, binary);
      api.setFile(tag, 'SHA256SUMS', sums);
      latestTag = tag;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      api.releasesUrl = `http://127.0.0.1:${server.address().port}/releases`;
      resolve(api);
    });
  });
}

function assetNameForHost() {
  const platform = { linux: 'linux', darwin: 'macos', win32: 'win' }[process.platform];
  return `pinggy-${platform}-${process.arch}${isWindows ? '.exe' : ''}`;
}

/** Copies the binary to the path the install scripts use, so it counts as an install that can update itself. */
function installInSandbox(binaryPath, sandbox) {
  const installPath = isWindows
    ? path.join(sandbox.env.LOCALAPPDATA, 'Pinggy', 'bin', 'pinggy.exe')
    : path.join(sandbox.home, '.pinggy', 'bin', 'pinggy');
  fs.rmSync(path.join(sandbox.home, '.pinggy'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installPath), { recursive: true });
  fs.copyFileSync(binaryPath, installPath);
  if (!isWindows) fs.chmodSync(installPath, 0o755);
  return installPath;
}

function updateEnvironment(server) {
  return { PINGGY_UPDATE_RELEASES_URL: server.releasesUrl };
}

function updateStatePath(sandbox) {
  return path.join(sandbox.pinggyConfigDir(), 'update.json');
}

function readUpdateState(sandbox) {
  try {
    return JSON.parse(fs.readFileSync(updateStatePath(sandbox), 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = {
  assetNameForHost,
  binaryVersion,
  bumpPatch,
  installInSandbox,
  readUpdateState,
  reportsVersion,
  runBinary,
  runBinaryAsync,
  runUnderTerminal,
  startFakeReleases,
  updateEnvironment,
  updateStatePath,
  waitFor,
};
