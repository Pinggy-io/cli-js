const fs = require('fs');
const path = require('path');
const { setBinary, runCase, getResults, workDir } = require('./lib/framework.cjs');

const binary = process.argv[2];
if (!binary) {
  console.error('Usage: node run.cjs <path-to-pinggy-binary>');
  process.exit(2);
}
const binaryPath = path.resolve(binary);
if (!fs.existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`);
  process.exit(2);
}
setBinary(binaryPath);

const cases = [
  // Daemon lifecycle
  require('./cases/daemon-start-stop.cjs'),
  require('./cases/daemon-status.cjs'),
  require('./cases/daemon-stale-pid.cjs'),

  // Config CRUD
  require('./cases/config-save-list.cjs'),
  require('./cases/config-save-full.cjs'),
  require('./cases/config-update.cjs'),
  require('./cases/config-delete.cjs'),
  require('./cases/config-name-validation.cjs'),
  require('./cases/config-auto-toggle.cjs'),

  // IPC direct 
  require('./cases/ipc-http.cjs'),
  require('./cases/ipc-loglevel.cjs'),

  // Legacy single-tunnel flag behaviors (network)
  require('./cases/serve.cjs'),
  require('./cases/headers.cjs'),
  require('./cases/basic-auth.cjs'),
  require('./cases/bearer-auth.cjs'),
  require('./cases/whitelist-allow.cjs'),
  require('./cases/whitelist-deny.cjs'),
  require('./cases/https-only.cjs'),
  require('./cases/tcp.cjs'),
  require('./cases/udp.cjs'),
  require('./cases/haproxy-tcp.cjs'),
  require('./cases/haproxy-non-tcp.cjs'),
  require('./cases/config-roundtrip.cjs'),
  require('./cases/debugger-ws.cjs'),

  // Subcommand-driven tunnel behaviors (network, via daemon)
  require('./cases/start-background.cjs'),
  require('./cases/ps-output.cjs'),
  require('./cases/stop-resolution.cjs'),
  require('./cases/restart.cjs'),

  // Foreground/detached lifecycle (network, via daemon)
  require('./cases/foreground-grace-stops.cjs'),
  require('./cases/detached-survives-cli-exit.cjs'),

  // Crash recovery and clean shutdown (network)
  require('./cases/clean-shutdown-clears-state.cjs'),
  require('./cases/crash-recovery-detached.cjs'),
];

async function main() {
  process.stdout.write(`Pinggy E2E suite\n`);
  process.stdout.write(`  binary: ${binaryPath}\n`);
  process.stdout.write(`  workdir: ${workDir}\n`);
  process.stdout.write(`  platform: ${process.platform} ${process.arch}\n`);

  let failed = false;
  for (const c of cases) {
    try {
      await runCase(c.name, c.run);
    } catch {
      failed = true;
      break;
    }
  }

  process.stdout.write(`\n=== summary ===\n`);
  for (const r of getResults()) {
    process.stdout.write(`  ${r.status}  ${r.name}\n`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(1);
});
