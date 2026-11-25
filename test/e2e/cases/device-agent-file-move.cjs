const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that turns the file manager on in welcome, with 3 slots, then asks the
// agent for 3 moves on 1 sandbox disk, 1 path each: a rename in place, a tree into another folder, and 1 file
// whose name the destination holds already, with fail. A rename is a move whose destination_path has a new last
// part. The built binary must answer each request on its own id, send progress
// with the totals for the moves that run and none for the refusal, and leave the disk as asked.
const TOKEN = 'pga_e2e_device_agent_file_move_0000';
const DEADLINE_MS = 30000;

const FOLDER = path.join(workDir, 'device-agent-file-move');
const SOURCE = path.join(FOLDER, 'src');
const DESTINATION = path.join(FOLDER, 'dest');
const RENAME_ID = 'e2e-move-rename';
const TREE_ID = 'e2e-move-tree';
const FAIL_ID = 'e2e-move-fail';
const ANSWERS_EXPECTED = 3;
const INDEX_TEXT = '<h1>hello</h1>';
const STYLE_TEXT = 'body { margin: 0 }';

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e7',
    accepted_proto: 1,
    heartbeat_interval_seconds: 30,
    stats_interval_seconds: 60,
    server_time: Math.floor(Date.now() / 1000),
    max_frame_bytes: 32768,
    terminal_enabled: false,
    file_manager_enabled: true,
    file_max_concurrent_operations: 3,
  };
}

function plantFolders() {
  fs.rmSync(FOLDER, { recursive: true, force: true });
  fs.mkdirSync(path.join(SOURCE, 'web', 'css'), { recursive: true });
  fs.mkdirSync(DESTINATION, { recursive: true });
  fs.writeFileSync(path.join(SOURCE, 'web', 'index.html'), INDEX_TEXT);
  fs.writeFileSync(path.join(SOURCE, 'web', 'css', 'site.css'), STYLE_TEXT);
  fs.writeFileSync(path.join(SOURCE, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(SOURCE, 'readme.txt'), 'new');
  fs.writeFileSync(path.join(DESTINATION, 'readme.txt'), 'kept');
}

function moveRequest(name, destinationPath = path.join(DESTINATION, name)) {
  return { source_path: path.join(SOURCE, name), destination_path: destinationPath };
}

function startFileDashboard() {
  return new Promise((resolve, reject) => {
    const received = { capabilities: null, answers: {}, progress: {} };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        const { kind, ch, op, payload, id } = inbound;

        if (ch === 'system' && op === 'hello') {
          received.capabilities = payload.capabilities;
          socket.send(frame('res', 'system', 'welcome', welcomePayload(), id));
          socket.send(frame('req', 'file', 'move',
            moveRequest('notes.txt', path.join(SOURCE, 'notes-old.txt')), RENAME_ID));
          socket.send(frame('req', 'file', 'move', moveRequest('web'), TREE_ID));
          socket.send(frame('req', 'file', 'move', moveRequest('readme.txt'), FAIL_ID));
        } else if (ch === 'file' && op === 'progress') {
          (received.progress[id] = received.progress[id] || []).push(payload);
        } else if (ch === 'file' && op === 'move' && kind === 'res') {
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

function readText(...parts) {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

function answeredWhole(answer) {
  return JSON.stringify(answer) === '{}';
}

module.exports = {
  name: 'device-agent-file-move',
  async run() {
    plantFolders();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-move.log');
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
        throw new Error(`the agent answered ${Object.keys(received.answers).join(', ') || 'no'} file/move requests`);
      }

      const renamed = received.answers[RENAME_ID];
      check(answeredWhole(renamed), `the rename answered ${JSON.stringify(renamed)}`);
      check(readText(SOURCE, 'notes-old.txt') === 'notes' && !fs.existsSync(path.join(SOURCE, 'notes.txt')),
        'the rename did not leave notes-old.txt alone in its place');
      process.stdout.write('  renamed notes.txt to notes-old.txt\n');

      const tree = received.answers[TREE_ID];
      check(answeredWhole(tree), `the tree move answered ${JSON.stringify(tree)}`);
      check(readText(DESTINATION, 'web', 'index.html') === INDEX_TEXT
        && readText(DESTINATION, 'web', 'css', 'site.css') === STYLE_TEXT, 'the moved tree differs on disk');
      check(!fs.existsSync(path.join(SOURCE, 'web')), 'the moved tree is still in the source folder');
      const treeProgress = received.progress[TREE_ID] || [];
      check(treeProgress.length > 0 && treeProgress[0].files_total === 1 && treeProgress[0].bytes_total === 0,
        `the tree move's progress was ${JSON.stringify(treeProgress)}`);
      process.stdout.write('  moved the tree, with the totals in the first progress\n');

      const refused = received.answers[FAIL_ID];
      check(JSON.stringify(refused) === JSON.stringify({
        error: { code: 'file_exists', message: '1 item already exists in the destination.' },
      }), `a clash with fail answered ${JSON.stringify(refused)}, not file_exists`);
      check(!received.progress[FAIL_ID], 'a refused move sent progress');
      check(readText(SOURCE, 'readme.txt') === 'new' && readText(DESTINATION, 'readme.txt') === 'kept',
        'a refused move changed a file');
      process.stdout.write('  refused the clash with file_exists, sent no progress, and moved nothing\n');
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
