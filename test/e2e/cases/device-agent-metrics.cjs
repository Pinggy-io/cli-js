const path = require('path');
const { WebSocketServer } = require('ws');
const { workDir, getBinary, spawnCli, killProc, dumpLogs, sleep } = require('../lib/framework.cjs');

// A local stand-in for the dashboard. It speaks just enough of the protocol to hand the agent a
// cadence, so the case needs no dashboard, no account, and no network.
const CONNECT_PATH = '/backend/api/v1/device-agent/ws/connect';
const TOKEN_HEADER = 'x-pinggy-device-token';
const TOKEN = 'pga_e2e_device_agent_metrics';

// Far below the 60 s dashboard default. 2 readings inside the deadline prove the agent used the
// cadence from welcome rather than a compiled-in one.
const STATS_INTERVAL_SECONDS = 2;
const HEARTBEAT_INTERVAL_SECONDS = 30;
const METRICS_FRAMES_WANTED = 2;
const DEADLINE_MS = 30000;
const MAX_GAP_BETWEEN_READINGS_MS = 10000;

const METRICS_FIELDS = [
  'cpu_percent', 'load_avg_1m', 'load_avg_5m', 'load_avg_15m',
  'memory_used_bytes', 'memory_total_bytes', 'uptime_seconds', 'collected_at',
];

function welcomeFrame() {
  return {
    v: 1, kind: 'res', ch: 'system', op: 'welcome', id: '', seq: 0, ts: Math.floor(Date.now() / 1000),
    payload: {
      device_agent_id: '00000000-0000-4000-8000-00000000e2e0',
      accepted_proto: 1,
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
      stats_interval_seconds: STATS_INTERVAL_SECONDS,
      server_time: Math.floor(Date.now() / 1000),
      max_frame_bytes: 65536,
    },
  };
}

function startFakeDashboard() {
  return new Promise((resolve, reject) => {
    const received = { handshakeErrors: [], info: null, metrics: [] };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket, req) => {
      if (req.url !== CONNECT_PATH) received.handshakeErrors.push(`path ${req.url}`);
      if (req.headers[TOKEN_HEADER] !== TOKEN) received.handshakeErrors.push('token header missing or wrong');

      socket.on('message', (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (frame.ch === 'system' && frame.op === 'hello') {
          socket.send(JSON.stringify(welcomeFrame()));
        } else if (frame.ch === 'device' && frame.op === 'info') {
          received.info = frame.payload;
        } else if (frame.ch === 'device' && frame.op === 'metrics') {
          received.metrics.push({ payload: frame.payload, receivedAtMillis: Date.now() });
        }
      });
    });

    server.once('listening', () => resolve({ server, port: server.address().port, received }));
    server.once('error', reject);
  });
}

function assertMetricsPlausible(metrics) {
  for (const field of METRICS_FIELDS) {
    if (typeof metrics[field] !== 'number' || Number.isNaN(metrics[field])) {
      throw new Error(`metrics.${field} is not a number: ${JSON.stringify(metrics)}`);
    }
  }
  if (metrics.cpu_percent < 0 || metrics.cpu_percent > 100) {
    throw new Error(`cpu_percent outside [0, 100]: ${metrics.cpu_percent}`);
  }
  if (!(metrics.memory_used_bytes > 0 && metrics.memory_used_bytes < metrics.memory_total_bytes)) {
    throw new Error(`memory_used_bytes ${metrics.memory_used_bytes} not in (0, ${metrics.memory_total_bytes})`);
  }
}

module.exports = {
  name: 'device-agent-metrics',
  async run() {
    const dashboard = await startFakeDashboard();
    const log = path.join(workDir, 'device-agent-metrics.log');
    const args = ['devices', 'connect', '--token', TOKEN, '--manage', `ws://127.0.0.1:${dashboard.port}`];
    process.stdout.write(`  args: ${args.join(' ')}\n`);
    const proc = spawnCli(getBinary(), args, { logFile: log });

    try {
      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline) {
        if (dashboard.received.info && dashboard.received.metrics.length >= METRICS_FRAMES_WANTED) break;
        if (proc.exitCode !== null) throw new Error(`agent exited early with code ${proc.exitCode}`);
        await sleep(250);
      }

      const { handshakeErrors, info, metrics } = dashboard.received;
      if (handshakeErrors.length) throw new Error(`bad handshake: ${handshakeErrors.join(', ')}`);
      if (!info) throw new Error('no device/info frame received');
      if (metrics.length < METRICS_FRAMES_WANTED) {
        throw new Error(`${metrics.length} device/metrics frame(s) within ${DEADLINE_MS / 1000}s, wanted ${METRICS_FRAMES_WANTED}`);
      }

      if (!(info.cpu_cores > 0 && info.total_memory_bytes > 0 && info.arch && info.os)) {
        throw new Error(`implausible device/info: ${JSON.stringify(info)}`);
      }
      metrics.forEach((reading) => assertMetricsPlausible(reading.payload));

      const gapMillis = metrics[1].receivedAtMillis - metrics[0].receivedAtMillis;
      if (gapMillis > MAX_GAP_BETWEEN_READINGS_MS) {
        throw new Error(`readings ${gapMillis} ms apart; welcome asked for ${STATS_INTERVAL_SECONDS}s`);
      }
      process.stdout.write(`  info: ${info.os} ${info.arch}, ${info.cpu_cores} cores; ` +
        `cpu ${metrics[1].payload.cpu_percent}%, readings ${gapMillis} ms apart\n`);
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
