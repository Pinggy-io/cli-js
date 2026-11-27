const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that allows 1 file operation at a time and 3 waiting, then sends 5 deletes at
// once: a large tree first, then 4 single files. The built binary must run the tree, line up the next 3 with
// queued_position 1, 2 and 3, refuse the 5th with file_busy at once, and answer the 4 that ran in the order sent.
const TOKEN = 'pga_e2e_device_agent_file_queue_000';
const DEADLINE_MS = 30000;
const TREE_FILE_COUNT = 2000;

const FOLDER = path.join(workDir, 'device-agent-file-queue');
const TREE = path.join(FOLDER, 'tree');
const WAITING_NAMES = ['b.txt', 'c.txt', 'd.txt'];
const REFUSED_NAME = 'e.txt';
const TREE_ID = 'e2e-queue-tree';
const WAITING_IDS = ['e2e-queue-1', 'e2e-queue-2', 'e2e-queue-3'];
const REFUSED_ID = 'e2e-queue-refused';
const ANSWERS_EXPECTED = 5;
const BUSY_MESSAGE = 'The device is already running 1 file operation, and 3 more are waiting.';

function frame(kind, ch, op, payload, id = '') {
  return JSON.stringify({ v: 1, kind, ch, op, id, seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function welcomePayload() {
  return {
    device_agent_id: '00000000-0000-4000-8000-00000000e2e9',
    accepted_proto: 1,
    heartbeat_interval_seconds: 30,
    stats_interval_seconds: 60,
    server_time: Math.floor(Date.now() / 1000),
    max_frame_bytes: 32768,
    terminal_enabled: false,
    file_manager_enabled: true,
    file_max_concurrent_operations: 1,
    file_max_queued_operations: 3,
  };
}

function plantFolder() {
  fs.rmSync(FOLDER, { recursive: true, force: true });
  fs.mkdirSync(TREE, { recursive: true });
  for (let index = 0; index < TREE_FILE_COUNT; index++) {
    fs.writeFileSync(path.join(TREE, `f${index}.txt`), 'x');
  }
  [...WAITING_NAMES, REFUSED_NAME].forEach((name) => fs.writeFileSync(path.join(FOLDER, name), 'x'));
}

function startFileDashboard() {
  return new Promise((resolve, reject) => {
    const received = { capabilities: null, answers: {}, answerOrder: [], progress: [] };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        const { kind, ch, op, payload, id } = inbound;

        if (ch === 'system' && op === 'hello') {
          received.capabilities = payload.capabilities;
          socket.send(frame('res', 'system', 'welcome', welcomePayload(), id));
          socket.send(frame('req', 'file', 'delete', { path: TREE }, TREE_ID));
          WAITING_NAMES.forEach((name, index) => {
            socket.send(frame('req', 'file', 'delete', { path: path.join(FOLDER, name) }, WAITING_IDS[index]));
          });
          socket.send(frame('req', 'file', 'delete', { path: path.join(FOLDER, REFUSED_NAME) }, REFUSED_ID));
        } else if (ch === 'file' && op === 'progress' && kind === 'event') {
          received.progress.push({ id, payload });
        } else if (ch === 'file' && op === 'delete' && kind === 'res') {
          received.answers[id] = payload;
          received.answerOrder.push(id);
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
  name: 'device-agent-file-queue',
  async run() {
    plantFolder();
    const dashboard = await startFileDashboard();
    const log = path.join(workDir, 'device-agent-file-queue.log');
    const args = ['device', 'connect', '--foreground', '--token', TOKEN,
        '--manage', `ws://127.0.0.1:${dashboard.port}`];
    process.stdout.write(`  args: ${args.join(' ')}\n`);
    const proc = spawnCli(getBinary(), args, { logFile: log });
    const { received } = dashboard;

    try {
      if (!(await waitFor(() => received.capabilities !== null))) throw new Error('the agent never sent hello');

      if (!(await waitFor(() => Object.keys(received.answers).length === ANSWERS_EXPECTED))) {
        throw new Error(`the agent answered ${received.answerOrder.join(', ') || 'no'} file/delete requests`);
      }

      const refused = received.answers[REFUSED_ID];
      check(refused.error && refused.error.code === 'file_busy' && refused.error.message === BUSY_MESSAGE,
        `the 5th delete answered ${JSON.stringify(refused)}, not file_busy with "${BUSY_MESSAGE}"`);
      check(!received.progress.some((event) => event.id === REFUSED_ID), 'the refused delete sent progress');
      check(fs.existsSync(path.join(FOLDER, REFUSED_NAME)), 'the refused delete removed its file');
      process.stdout.write('  refused the 5th with file_busy, at once and with no progress\n');

      WAITING_IDS.forEach((id, index) => {
        const first = received.progress.find((event) => event.id === id);
        const heard = first && first.payload;
        check(heard && heard.queued_position === index + 1 && Object.keys(heard).length === 1,
          `request ${index + 2} first heard ${JSON.stringify(heard)}, not queued_position ${index + 1}`);
      });
      process.stdout.write('  lined up the 2nd, 3rd and 4th at places 1, 2 and 3\n');

      const ran = received.answerOrder.filter((id) => id !== REFUSED_ID);
      check(JSON.stringify(ran) === JSON.stringify([TREE_ID, ...WAITING_IDS]),
        `the 4 that ran answered in the order ${ran.join(', ')}`);
      [TREE_ID, ...WAITING_IDS].forEach((id) => {
        const answer = received.answers[id];
        check(JSON.stringify(answer) === '{}', `${id} answered ${JSON.stringify(answer)}`);
      });
      check(!fs.existsSync(TREE) && WAITING_NAMES.every((name) => !fs.existsSync(path.join(FOLDER, name))),
        'a delete that answered left its item on disk');
      process.stdout.write('  ran the tree, then the 3 waiting, in the order sent\n');
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
