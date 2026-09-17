const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard that revokes the agent's credential right after it connects,
// the way a token rotation does: system/disconnect {reason: revoked}, then close code 4001.
const TOKEN = 'pga_e2e_device_agent_revoked_000000';
const CLOSE_CODE_TERMINAL = 4001;

// Longer than the agent's 5 s reconnect sleep, so a retry would be seen.
const WATCH_FOR_RECONNECT_MS = 8000;

function frame(kind, ch, op, payload) {
  return JSON.stringify({ v: 1, kind, ch, op, id: '', seq: 0, ts: Math.floor(Date.now() / 1000), payload });
}

function startRevokingDashboard() {
  return new Promise((resolve, reject) => {
    const received = { connections: 0, revokedAtMillis: null };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      received.connections += 1;
      socket.on('message', (data) => {
        let inbound;
        try { inbound = JSON.parse(data.toString()); } catch { return; }
        if (inbound.ch === 'system' && inbound.op === 'hello') {
          socket.send(frame('res', 'system', 'welcome', {
            device_agent_id: '00000000-0000-4000-8000-00000000e2e1',
            accepted_proto: 1,
            heartbeat_interval_seconds: 30,
            stats_interval_seconds: 60,
            server_time: Math.floor(Date.now() / 1000),
            max_frame_bytes: 65536,
          }));
        } else if (inbound.ch === 'device' && inbound.op === 'info' && received.revokedAtMillis === null) {
          received.revokedAtMillis = Date.now();
          socket.send(frame('event', 'system', 'disconnect', { reason: 'revoked' }));
          socket.close(CLOSE_CODE_TERMINAL);
        }
      });
    });

    server.once('listening', () => resolve({ server, port: server.address().port, received }));
    server.once('error', reject);
  });
}

function readLogs(log) {
  return ['', '.err']
    .map((suffix) => (fs.existsSync(log + suffix) ? fs.readFileSync(log + suffix, 'utf8') : ''))
    .join('\n');
}

module.exports = {
  name: 'device-agent-revoked',
  async run() {
    const dashboard = await startRevokingDashboard();
    const log = path.join(workDir, 'device-agent-revoked.log');
    const args = ['devices', 'connect', '--token', TOKEN, '--manage', `ws://127.0.0.1:${dashboard.port}`];
    process.stdout.write(`  args: ${args.join(' ')}\n`);
    const proc = spawnCli(getBinary(), args, { logFile: log });

    try {
      const deadline = Date.now() + WATCH_FOR_RECONNECT_MS;
      while (Date.now() < deadline && dashboard.received.connections < 2) {
        await sleep(250);
      }

      const { connections, revokedAtMillis } = dashboard.received;
      if (revokedAtMillis === null) throw new Error('the agent never sent device/info, so it was never revoked');
      if (connections > 1) throw new Error(`the agent reconnected after 4001 (${connections} connections)`);
      if (proc.exitCode === null) throw new Error('the agent is still running after being revoked');
      if (!/credential revoked/i.test(readLogs(log))) {
        throw new Error('the agent did not print that its credential was revoked');
      }
      process.stdout.write(`  exited with code ${proc.exitCode} after 1 connection\n`);
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
