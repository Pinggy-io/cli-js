const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWindows = process.platform === 'win32';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchUrls(debuggerPort) {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    try {
      const res = await fetch(`http://${host}:${debuggerPort}/urls`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.urls) && data.urls.length > 0) return data;
    } catch {}
  }
  return null;
}

function extractUrlsFromLog(content) {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf('Tunnel started ');
    if (idx === -1) continue;
    const jsonStart = line.indexOf('{', idx);
    if (jsonStart === -1) continue;
    try {
      const obj = JSON.parse(line.slice(jsonStart));
      if (obj && Array.isArray(obj.urls) && obj.urls.length > 0) return obj.urls;
    } catch {}
  }
  return null;
}

function detectFatalErrorInLog(content) {
  const errorPatterns = [
    /Tunnel failed/i,
    /Authentication failed/i,
    /\[CLI\] \[error\]/,
    /RemoteManagementUnauthorizedError/,
    /unable to start tunnel/i,
  ];
  for (const re of errorPatterns) {
    const m = content.match(re);
    if (m) {
      const lineStart = content.lastIndexOf('\n', m.index) + 1;
      const lineEnd = content.indexOf('\n', m.index);
      return content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    }
  }
  return null;
}

async function waitForTunnel({ logFile, debuggerPort }, { maxMs = 60000, pollMs = 500 } = {}) {
  const deadline = Date.now() + maxMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    if (logFile && fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      const urls = extractUrlsFromLog(content);
      if (urls) return urls;
      lastErr = detectFatalErrorInLog(content);
      if (lastErr) throw new Error(`CLI reported fatal error: ${lastErr.trim()}`);
    }

    if (debuggerPort) {
      const data = await fetchUrls(debuggerPort);
      if (data && Array.isArray(data.urls) && data.urls.length > 0) return data.urls;
    }

    await sleep(pollMs);
  }
  return null;
}

function killProc(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  if (isWindows) {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  } else {
    try {
      proc.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 5000).unref();
  }
}

function spawnCli(binary, args, { logFile, cwd } = {}) {
  const out = logFile ? fs.openSync(logFile, 'w') : 'ignore';
  const err = logFile ? fs.openSync(logFile + '.err', 'w') : 'ignore';
  const proc = spawn(binary, args, {
    stdio: ['ignore', out, err],
    cwd: cwd || process.cwd(),
    windowsHide: true,
  });
  return proc;
}

function dumpLogs(logFile) {
  for (const suffix of ['', '.err']) {
    const p = logFile + suffix;
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      if (content.trim()) {
        process.stdout.write(`--- ${path.basename(p)} ---\n${content}\n`);
      }
    }
  }
}

async function startEchoServer(script, port = 0) {
  const proc = spawn(process.execPath, [script, String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const actualPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`echo server ${script} did not start in time`)), 10000);
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const m = buf.match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(parseInt(m[1], 10));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`echo server ${script} exited early with code ${code}`));
    });
  });
  return { proc, port: actualPort };
}

function stopEchoServer(echo) {
  if (!echo || !echo.proc) return;
  killProc(echo.proc);
}

module.exports = {
  isWindows,
  sleep,
  fetchUrls,
  waitForTunnel,
  killProc,
  spawnCli,
  dumpLogs,
  startEchoServer,
  stopEchoServer,
};
