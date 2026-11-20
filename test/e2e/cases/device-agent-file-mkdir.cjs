const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that turns the file manager on in welcome, then asks the agent to
// make 1 new folder and 1 whose name a file already holds, in 1 sandbox folder. welcome allows no delete,
// since mkdir takes no slot. The built binary must answer each request on its own id, with the new
// folder's path or file_exists, and leave the disk as asked.
const TOKEN = 'pga_e2e_device_agent_file_mkdir_000';
const DEADLINE_MS = 30000;

const FOLDER = path.join(workDir, 'device-agent-file-mkdir');
const REPORTS = path.join(FOLDER, 'reports');
const TAKEN = path.join(FOLDER, 'notes');
const MKDIR_ID = 'e2e-mkdir-new';
const MKDIR_TAKEN_ID = 'e2e-mkdir-taken';
const ANSWERS_EXPECTED = 2;

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e6',
    accepted_proto: 1,
    heartbeat_interval_seconds: 30,
    stats_interval_seconds: 60,
    server_time: Math.floor(Date.now() / 1000),
    max_frame_bytes: 32768,
    terminal_enabled: false,
    file_manager_enabled: true,
  };
}

function plantFolder() {
  fs.rmSync(FOLDER, { recursive: true, force: true });
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(TAKEN, 'kept');
}

function startFileDashboard() {
  return new Promise((resolve, reject) => {
    const received = { capabilities: null, answers: {}, progress: 0 };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        const { kind, ch, op, payload, id } = inbound;

        if (ch === 'system' && op === 'hello') {
          received.capabilities = payload.capabilities;
          socket.send(frame('res', 'system', 'welcome', welcomePayload(), id));
          socket.send(frame('req', 'file', 'mkdir', { directory: FOLDER, name: 'reports' }, MKDIR_ID));
          socket.send(frame('req', 'file', 'mkdir', { directory: FOLDER, name: 'notes' }, MKDIR_TAKEN_ID));
        } else if (ch === 'file' && op === 'progress') {
          received.progress += 1;
        } else if (ch === 'file' && op === 'mkdir' && kind === 'res') {
          received.answers[id] = payload;
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

function check(condition, message) {
  if (!condition) throw new Error(message);
}

module.exports = {
  name: 'device-agent-file-mkdir',
  async run() {
    plantFolder();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-mkdir.log');
    const args = ['device', 'connect', '--foreground', '--token', TOKEN,
        '--manage', `ws://127.0.0.1:${dashboard.port}`];
    process.stdout.write(`  args: ${args.join(' ')}\n`);
    const proc = spawnCli(getBinary(), args, { logFile: log });
    const { received } = dashboard;

    try {
      if (!(await waitFor(() => received.capabilities !== null))) throw new Error('the agent never sent hello');
      check(received.capabilities.includes('file_manager'),
        `the agent did not advertise file_manager: ${received.capabilities.join(', ')}`);

      if (!(await waitFor(() => Object.keys(received.answers).length === ANSWERS_EXPECTED))) {
        throw new Error(`the agent answered ${Object.keys(received.answers).join(', ') || 'no'} file/mkdir requests`);
      }

      const made = received.answers[MKDIR_ID];
      check(!made.error, `file/mkdir refused: ${JSON.stringify(made.error)}`);
      check(made.path === REPORTS, `the answer's path was ${JSON.stringify(made.path)}, not the new folder`);
      check(fs.statSync(REPORTS).isDirectory() && fs.readdirSync(REPORTS).length === 0,
        'the new folder is not an empty folder on disk');
      process.stdout.write('  made the folder and answered its path\n');

      const taken = received.answers[MKDIR_TAKEN_ID];
      check(taken.error && taken.error.code === 'file_exists',
        `a taken name answered ${JSON.stringify(taken)}, not file_exists`);
      check(fs.readFileSync(TAKEN, 'utf8') === 'kept', 'the file holding the name changed');
      process.stdout.write('  refused a taken name with file_exists and left the file\n');

      check(received.progress === 0, 'a mkdir sent progress');
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
