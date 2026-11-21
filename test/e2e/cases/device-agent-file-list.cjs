const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that turns the file manager on in welcome, then lists 1 folder,
// the home folder, and a relative path. The built binary must answer each on its own id.
const TOKEN = 'pga_e2e_device_agent_file_list_000';
const DEADLINE_MS = 30000;

const FOLDER = path.join(workDir, 'device-agent-file-list');
const LIST_FOLDER_ID = 'e2e-list-folder';
const LIST_HOME_ID = 'e2e-list-home';
const LIST_RELATIVE_ID = 'e2e-list-relative';

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e3',
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
  fs.writeFileSync(path.join(FOLDER, 'b.txt'), 'bbb');
  fs.writeFileSync(path.join(FOLDER, 'a.txt'), 'a');
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
          socket.send(frame('req', 'file', 'list', { path: FOLDER }, LIST_FOLDER_ID));
          socket.send(frame('req', 'file', 'list', {}, LIST_HOME_ID));
          socket.send(frame('req', 'file', 'list', { path: 'relative/folder' }, LIST_RELATIVE_ID));
        } else if (ch === 'file' && op === 'list' && kind === 'res') {
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
  name: 'device-agent-file-list',
  async run() {
    plantFolder();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-list.log');
    const args = ['device', 'connect', '--foreground', '--token', TOKEN,
        '--manage', `ws://127.0.0.1:${dashboard.port}`];
    process.stdout.write(`  args: ${args.join(' ')}\n`);
    const proc = spawnCli(getBinary(), args, { logFile: log });
    const { received } = dashboard;

    try {
      if (!(await waitFor(() => received.capabilities !== null))) throw new Error('the agent never sent hello');
      check(received.capabilities.includes('file_manager'),
        `the agent did not advertise file_manager: ${received.capabilities.join(', ')}`);

      if (!(await waitFor(() => Object.keys(received.answers).length === 3))) {
        throw new Error(`the agent answered ${Object.keys(received.answers).join(', ') || 'no'} file/list requests`);
      }

      const folder = received.answers[LIST_FOLDER_ID];
      check(!folder.error, `file/list of the folder refused: ${JSON.stringify(folder.error)}`);
      check(folder.path === FOLDER, `listed ${folder.path}, not ${FOLDER}`);
      const names = folder.entries.map((entry) => entry.name);
      check(JSON.stringify(names) === JSON.stringify(['inner', 'a.txt', 'b.txt']),
        `entries were ${JSON.stringify(names)}: the folder first, then the files by name, no dot file`);
      check(folder.total === 3, `total was ${folder.total}, not 3`);
      check(folder.next_offset === undefined, 'a 3-entry folder came back with a next page');
      check(folder.entries[2].size_bytes === 3, `b.txt had size ${folder.entries[2].size_bytes}, not 3`);
      process.stdout.write(`  listed ${names.length} entries in the folder\n`);

      const home = received.answers[LIST_HOME_ID];
      check(!home.error, `file/list of the home folder refused: ${JSON.stringify(home.error)}`);
      check(home.home === home.path, `home ${home.home} is not the listed path ${home.path}`);
      check(Array.isArray(home.roots) && home.roots.length > 0, `roots were ${JSON.stringify(home.roots)}`);
      process.stdout.write(`  listed the home folder, roots ${JSON.stringify(home.roots)}\n`);

      const relative = received.answers[LIST_RELATIVE_ID];
      check(relative.error && relative.error.code === 'invalid_path',
        `a relative path answered ${JSON.stringify(relative)}, not invalid_path`);
      process.stdout.write('  refused a relative path\n');
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
