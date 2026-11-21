const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that turns the file manager on in welcome, with 3 slots, then asks the
// agent for 3 copies from 1 sandbox folder into another: a tree into an empty destination, and 1 file whose
// name the destination holds already, once with fail and once with keep_both. The built binary must answer
// each request on its own id, send progress for the copies that run and none for the refusal, and leave the
// disk as asked.
const TOKEN = 'pga_e2e_device_agent_file_copy_0000';
const DEADLINE_MS = 30000;

const FOLDER = path.join(workDir, 'device-agent-file-copy');
const SOURCE = path.join(FOLDER, 'src');
const DESTINATION = path.join(FOLDER, 'dest');
const TREE_ID = 'e2e-copy-tree';
const FAIL_ID = 'e2e-copy-fail';
const KEEP_BOTH_ID = 'e2e-copy-keep-both';
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
  fs.writeFileSync(path.join(SOURCE, 'notes.txt'), 'new');
  fs.writeFileSync(path.join(DESTINATION, 'notes.txt'), 'kept');
}

function copyRequest(names, onConflict) {
  const payload = { source_directory: SOURCE, names, destination_directory: DESTINATION };
  return onConflict ? { ...payload, on_conflict: onConflict } : payload;
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
          socket.send(frame('req', 'file', 'copy', copyRequest(['web']), TREE_ID));
          socket.send(frame('req', 'file', 'copy', copyRequest(['notes.txt']), FAIL_ID));
          socket.send(frame('req', 'file', 'copy', copyRequest(['notes.txt'], 'keep_both'), KEEP_BOTH_ID));
        } else if (ch === 'file' && op === 'progress') {
          (received.progress[id] = received.progress[id] || []).push(payload);
        } else if (ch === 'file' && op === 'copy' && kind === 'res') {
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

module.exports = {
  name: 'device-agent-file-copy',
  async run() {
    plantFolders();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-copy.log');
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
        throw new Error(`the agent answered ${Object.keys(received.answers).join(', ') || 'no'} file/copy requests`);
      }

      const tree = received.answers[TREE_ID];
      check(!tree.error, `the tree copy refused: ${JSON.stringify(tree.error)}`);
      check(tree.completed_count === 1 && tree.skipped_count === 0 && tree.failed_count === 0,
        `the tree copy answered ${JSON.stringify(tree)}`);
      check(readText(DESTINATION, 'web', 'index.html') === INDEX_TEXT
        && readText(DESTINATION, 'web', 'css', 'site.css') === STYLE_TEXT, 'the copied tree differs on disk');
      const treeProgress = received.progress[TREE_ID] || [];
      check(treeProgress.length > 0 && treeProgress.every((sent) => typeof sent.bytes_done === 'number'),
        `the tree copy's progress was ${JSON.stringify(treeProgress)}`);
      process.stdout.write('  copied the tree, with progress carrying bytes_done\n');

      const refused = received.answers[FAIL_ID];
      check(refused.error && refused.error.code === 'file_exists' && refused.error.conflict_count === 1
        && JSON.stringify(refused.error.conflicts) === '["notes.txt"]',
        `a clash with fail answered ${JSON.stringify(refused)}, not file_exists with the clash`);
      check(!received.progress[FAIL_ID], 'a refused copy sent progress');
      process.stdout.write('  refused the clash with file_exists and sent no progress\n');

      const keptBoth = received.answers[KEEP_BOTH_ID];
      check(!keptBoth.error && keptBoth.completed_count === 1,
        `a clash with keep_both answered ${JSON.stringify(keptBoth)}`);
      check(readText(DESTINATION, 'notes (1).txt') === 'new', 'keep_both did not write "notes (1).txt"');
      check(readText(DESTINATION, 'notes.txt') === 'kept', 'the file holding the name changed');
      process.stdout.write('  kept both under "notes (1).txt" and left the file\n');
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
