const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that turns the file manager on in welcome, then asks the agent to
// delete a file, a folder tree and a name that does not exist, all from 1 sandbox folder, and to delete
// from a folder that does not exist. The built binary must send progress on the request's id, answer
// each request on its own id, and leave the disk as asked.
const TOKEN = 'pga_e2e_device_agent_file_delete_00';
const DEADLINE_MS = 30000;

const FOLDER = path.join(workDir, 'device-agent-file-delete');
const NOTES = path.join(FOLDER, 'notes.txt');
const TREE = path.join(FOLDER, 'tree');
const KEPT = path.join(FOLDER, 'kept.txt');
const DELETE_ID = 'e2e-delete-names';
const DELETE_MISSING_FOLDER_ID = 'e2e-delete-missing-folder';
const ANSWERS_EXPECTED = 2;

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e5',
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

function plantFolder() {
  fs.rmSync(FOLDER, { recursive: true, force: true });
  fs.mkdirSync(path.join(TREE, 'sub'), { recursive: true });
  fs.writeFileSync(NOTES, 'abc');
  fs.writeFileSync(path.join(TREE, 'a.txt'), 'a');
  fs.writeFileSync(path.join(TREE, 'sub', 'b.txt'), 'b');
  fs.writeFileSync(KEPT, 'k');
}

function startFileDashboard() {
  return new Promise((resolve, reject) => {
    const received = { capabilities: null, answers: {}, progress: [] };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        const { kind, ch, op, payload, id } = inbound;

        if (ch === 'system' && op === 'hello') {
          received.capabilities = payload.capabilities;
          socket.send(frame('res', 'system', 'welcome', welcomePayload(), id));
          socket.send(frame('req', 'file', 'delete',
            { directory: FOLDER, names: ['notes.txt', 'tree', 'gone.txt'] }, DELETE_ID));
          socket.send(frame('req', 'file', 'delete',
            { directory: path.join(FOLDER, 'nowhere'), names: ['x'] }, DELETE_MISSING_FOLDER_ID));
        } else if (ch === 'file' && op === 'progress' && kind === 'event') {
          received.progress.push({ id, payload, answered: Object.keys(received.answers).includes(id) });
        } else if (ch === 'file' && op === 'delete' && kind === 'res') {
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
  name: 'device-agent-file-delete',
  async run() {
    plantFolder();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-delete.log');
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
        throw new Error(`the agent answered ${Object.keys(received.answers).join(', ') || 'no'} file/delete requests`);
      }

      const answer = received.answers[DELETE_ID];
      check(!answer.error, `file/delete refused: ${JSON.stringify(answer.error)}`);
      check(answer.completed_count === 2 && answer.failed_count === 1,
        `the delete answered ${JSON.stringify(answer)}, not 2 deleted and 1 failed`);
      check(answer.failed[0].name === 'gone.txt' && answer.failed[0].error.code === 'path_not_found',
        `the missing name failed as ${JSON.stringify(answer.failed)}, not path_not_found`);
      check(!fs.existsSync(NOTES) && !fs.existsSync(TREE), 'the file or the tree is still on disk');
      check(fs.existsSync(KEPT), 'a name the request did not hold was deleted');
      process.stdout.write('  deleted the file and the tree, refused the missing name\n');

      const progress = received.progress.filter((event) => event.id === DELETE_ID);
      check(progress.length >= 1, 'no progress arrived on the delete\'s id');
      check(progress[0].payload.items_total === 3 && progress[0].payload.current_name === 'notes.txt',
        `the first progress was ${JSON.stringify(progress[0].payload)}`);
      check(progress.every((event) => !event.answered), 'a progress arrived after its answer');
      process.stdout.write(`  ${progress.length} progress event(s) on the delete's id, all before the answer\n`);

      const missingFolder = received.answers[DELETE_MISSING_FOLDER_ID];
      check(missingFolder.error && missingFolder.error.code === 'path_not_found',
        `a missing folder answered ${JSON.stringify(missingFolder)}, not path_not_found`);
      check(!received.progress.some((event) => event.id === DELETE_MISSING_FOLDER_ID),
        'a refused delete sent progress');
      process.stdout.write('  refused a missing folder with no progress\n');
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
