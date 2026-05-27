const fs = require('fs');
const { spawn } = require('child_process');
const { sleep, isWindows, buildEnv } = require('./cli.cjs');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function runSubcommand(binary, args, { timeoutMs = 20000, input = null, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(env),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWindows) {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        } else {
          proc.kill('SIGKILL');
        }
      } catch {}
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString('utf-8'); });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });
    if (input != null) {
      proc.stdin.end(input);
    } else {
      proc.stdin.end();
    }
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        combined: stripAnsi(stdout + stderr),
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        signal: null,
        timedOut,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr + '\n' + err.message),
        combined: stripAnsi(stdout + stderr + '\n' + err.message),
      });
    });
  });
}

function readDaemonInfo(sandbox) {
  try {
    const raw = fs.readFileSync(sandbox.daemonJsonPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readDaemonState(sandbox) {
  try {
    const raw = fs.readFileSync(sandbox.daemonStatePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readDaemonConfig(sandbox) {
  try {
    const raw = fs.readFileSync(sandbox.daemonConfigPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForDaemonInfo(sandbox, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const info = readDaemonInfo(sandbox);
    if (info && info.pid && info.port && isPidAlive(info.pid)) return info;
    await sleep(100);
  }
  return null;
}

async function waitForDaemonGone(sandbox, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const info = readDaemonInfo(sandbox);
    if (!info || !isPidAlive(info.pid)) return true;
    await sleep(100);
  }
  return false;
}

async function startDaemon(binary, sandbox) {
  const res = await runSubcommand(binary, ['daemon', 'start'], { timeoutMs: 15000 });
  if (res.code !== 0) {
    throw new Error(`daemon start exited ${res.code}: ${res.combined}`);
  }
  const info = await waitForDaemonInfo(sandbox, 8000);
  if (!info) {
    throw new Error(`daemon.json did not appear after \`daemon start\`. stdout: ${res.stdout}`);
  }
  return info;
}

async function stopDaemon(binary, sandbox, { force = true } = {}) {
  const info = readDaemonInfo(sandbox);
  if (!info) return { ok: true, alreadyGone: true };

  const res = await runSubcommand(binary, ['daemon', 'stop'], { timeoutMs: 10000 });
  const exited = await waitForDaemonGone(sandbox, 8000);
  if (exited) return { ok: true, alreadyGone: false, out: res };

  if (force && isPidAlive(info.pid)) {
    try { process.kill(info.pid, 'SIGKILL'); } catch {}
    try { fs.unlinkSync(sandbox.daemonJsonPath()); } catch {}
  }
  return { ok: false, alreadyGone: false, out: res };
}

async function ipcRequest(sandbox, method, route, body) {
  const info = readDaemonInfo(sandbox);
  if (!info) throw new Error('IPC request requires running daemon');
  const opts = {
    method,
    headers: { 'X-Pinggy-Origin': 'app' },
    signal: AbortSignal.timeout(15000),
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${info.port}${route}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

async function withDaemon(binary, sandbox, fn) {
  sandbox.reset();
  const info = await startDaemon(binary, sandbox);
  try {
    return await fn(info);
  } finally {
    await stopDaemon(binary, sandbox);
  }
}

module.exports = {
  stripAnsi,
  runSubcommand,
  readDaemonInfo,
  readDaemonState,
  readDaemonConfig,
  waitForDaemonInfo,
  waitForDaemonGone,
  startDaemon,
  stopDaemon,
  ipcRequest,
  withDaemon,
  isPidAlive,
};
