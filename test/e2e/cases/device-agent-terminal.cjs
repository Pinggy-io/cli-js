const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, sandbox, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that opens 1 shell on the agent and runs 1 command in it. The
// output must hold the command's result, not its echo, so a real shell has to run it.
const TOKEN = 'pga_e2e_device_agent_terminal_0000';
const TERMINAL_ID = 'e2e-terminal-1';
const MARKER = 'PINGGY_TERM_OK_42';
const DEADLINE_MS = 30000;

const isWindows = process.platform === 'win32';
// ConPTY takes Enter as \r. PowerShell is named, so a SHELL set by the CI runner does not pick the shell.
const SHELL = isWindows ? 'powershell.exe' : null;
const COMMAND = isWindows ? `"PINGGY_TERM_OK_" + (40+2)\r` : 'echo PINGGY_TERM_OK_$((40+2))\n';

const NODE_PTY_VERSION = require('node-pty/package.json').version;
const NATIVE_DIRECTORIES = [
  path.join('build', 'Release'),
  path.join('prebuilds', `${process.platform}-${process.arch}`),
];

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e2',
    accepted_proto: 1,
    heartbeat_interval_seconds: 30,
    stats_interval_seconds: 60,
    server_time: Math.floor(Date.now() / 1000),
    max_frame_bytes: 65536,
    terminal_enabled: true,
    max_terminals_per_device: 3,
    terminal_window_bytes: 262144,
  };
}

function runtimeCopyDir() {
  return path.join(sandbox.pinggyConfigDir(), 'runtime',
    `node-pty-${NODE_PTY_VERSION}-${process.platform}-${process.arch}`);
}

// The copy a Linux binary up to 0.6.5 left behind: the manifest and no addon. It blocked the rename
// of a complete copy, so the terminal stayed off after an upgrade.
function plantIncompleteCopy() {
  const dir = runtimeCopyDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(require.resolve('node-pty/package.json'), path.join(dir, 'package.json'));
}

function copyHasAddon() {
  return NATIVE_DIRECTORIES.some((directory) => fs.existsSync(path.join(runtimeCopyDir(), directory, 'pty.node')));
}

function startShellDashboard() {
  return new Promise((resolve, reject) => {
    const received = { capabilities: null, opened: null, output: '' };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      let drawnBytes = 0;
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        const { ch, op, payload } = inbound;

        if (ch === 'system' && op === 'hello') {
          received.capabilities = payload.capabilities;
          socket.send(frame('res', 'system', 'welcome', welcomePayload(), inbound.id));
          if (payload.capabilities.includes('terminal')) {
            socket.send(frame('req', 'terminal', 'open',
              { terminal_id: TERMINAL_ID, cols: 80, rows: 24, shell: SHELL }, 'e2e-open-1'));
          }
        } else if (ch === 'terminal' && op === 'opened') {
          received.opened = payload;
          if (payload.error) return;
          socket.send(frame('event', 'terminal', 'data',
            { terminal_id: TERMINAL_ID, data: Buffer.from(COMMAND).toString('base64') }));
        } else if (ch === 'terminal' && op === 'data') {
          const bytes = Buffer.from(payload.data, 'base64');
          drawnBytes += bytes.length;
          received.output += bytes.toString('utf8');
          socket.send(frame('event', 'terminal', 'ack', { terminal_id: TERMINAL_ID, ack_bytes: drawnBytes }));
        }
      });
    });

    server.once('listening', () => resolve({ server, port: server.address().port, received }));
    server.once('error', reject);
  });
}

async function waitFor(condition) {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline && !condition()) {
    await sleep(250);
  }
  return condition();
}

module.exports = {
  name: 'device-agent-terminal',
  async run() {
    plantIncompleteCopy();
    const dashboard = await startShellDashboard();
    const log = path.join(workDir, 'device-agent-terminal.log');
    const args = ['device', 'connect', '--foreground', '--token', TOKEN,
        '--manage', `ws://127.0.0.1:${dashboard.port}`];
    process.stdout.write(`  args: ${args.join(' ')}\n`);
    const proc = spawnCli(getBinary(), args, { logFile: log });
    const { received } = dashboard;

    try {
      if (!(await waitFor(() => received.capabilities !== null))) {
        throw new Error('the agent never sent hello');
      }
      if (!received.capabilities.includes('terminal')) {
        throw new Error(`the agent did not advertise terminal, so node-pty did not load: ${received.capabilities.join(', ')}`);
      }
      if (!copyHasAddon()) throw new Error(`the runtime copy has no pty.node: ${runtimeCopyDir()}`);

      if (!(await waitFor(() => received.opened !== null))) throw new Error('the agent never answered terminal/open');
      if (received.opened.error) throw new Error(`terminal/open refused: ${JSON.stringify(received.opened.error)}`);
      process.stdout.write(`  opened ${received.opened.shell} as pid ${received.opened.pid}\n`);

      if (!(await waitFor(() => received.output.includes(MARKER)))) {
        throw new Error(`the shell never printed ${MARKER}. Output: ${JSON.stringify(received.output.slice(-500))}`);
      }
      process.stdout.write(`  the shell ran the command\n`);
    } catch (err) {
      dumpLogs(log);
      throw err;
    } finally {
      killProc(proc);
      dashboard.server.close();
      await sleep(500);
    }
  },
};
