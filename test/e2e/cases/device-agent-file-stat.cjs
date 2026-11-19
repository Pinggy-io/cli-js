const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that turns the file manager on in welcome, then asks for the
// details of a file, of a folder with and without its dot names, and of a path that does not exist.
// The built binary must answer each on its own id.
const TOKEN = 'pga_e2e_device_agent_file_stat_000';
const DEADLINE_MS = 30000;

const FOLDER = path.join(workDir, 'device-agent-file-stat');
const FILE = path.join(FOLDER, 'notes.txt');
const STAT_FILE_ID = 'e2e-stat-file';
const STAT_FOLDER_ID = 'e2e-stat-folder';
const STAT_FOLDER_HIDDEN_ID = 'e2e-stat-folder-hidden';
const STAT_MISSING_ID = 'e2e-stat-missing';
const ANSWERS_EXPECTED = 4;

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e4',
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
  fs.mkdirSync(path.join(FOLDER, 'inner'), { recursive: true });
  fs.writeFileSync(FILE, 'abc');
  fs.writeFileSync(path.join(FOLDER, '.hidden'), 'h');
}

function startFileDashboard() {
  return new Promise((resolve, reject) => {
    const received = { capabilities: null, answers: {} };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        const { kind, ch, op, payload, id } = inbound;

        if (ch === 'system' && op === 'hello') {
          received.capabilities = payload.capabilities;
          socket.send(frame('res', 'system', 'welcome', welcomePayload(), id));
          socket.send(frame('req', 'file', 'stat', { path: FILE }, STAT_FILE_ID));
          socket.send(frame('req', 'file', 'stat', { path: FOLDER }, STAT_FOLDER_ID));
          socket.send(frame('req', 'file', 'stat', { path: FOLDER, include_hidden: true }, STAT_FOLDER_HIDDEN_ID));
          socket.send(frame('req', 'file', 'stat', { path: path.join(FOLDER, 'gone.txt') }, STAT_MISSING_ID));
        } else if (ch === 'file' && op === 'stat' && kind === 'res') {
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
  name: 'device-agent-file-stat',
  async run() {
    plantFolder();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-stat.log');
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
        throw new Error(`the agent answered ${Object.keys(received.answers).join(', ') || 'no'} file/stat requests`);
      }

      const file = received.answers[STAT_FILE_ID];
      check(!file.error, `file/stat of the file refused: ${JSON.stringify(file.error)}`);
      check(file.path === FILE && file.name === 'notes.txt', `described ${file.path} as ${file.name}`);
      check(file.type === 'file', `the file's type was ${file.type}`);
      check(file.size_bytes === 3, `the file's size was ${file.size_bytes}, not 3`);
      check(typeof file.modified_at === 'number', `modified_at was ${file.modified_at}`);
      process.stdout.write(`  described the file: ${file.size_bytes} bytes, mode ${file.mode}\n`);

      const folder = received.answers[STAT_FOLDER_ID];
      check(!folder.error, `file/stat of the folder refused: ${JSON.stringify(folder.error)}`);
      check(folder.type === 'directory', `the folder's type was ${folder.type}`);
      check(folder.entry_count === 2, `entry_count was ${folder.entry_count}, not 2: the dot file counts only on request`);
      const withHidden = received.answers[STAT_FOLDER_HIDDEN_ID];
      check(withHidden.entry_count === 3, `entry_count with include_hidden was ${withHidden.entry_count}, not 3`);
      process.stdout.write(`  counted ${folder.entry_count} entries, ${withHidden.entry_count} with dot names\n`);

      const missing = received.answers[STAT_MISSING_ID];
      check(missing.error && missing.error.code === 'path_not_found',
        `a missing path answered ${JSON.stringify(missing)}, not path_not_found`);
      process.stdout.write('  refused a missing path\n');
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
