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
  require('./cases/serve.cjs'),
  require('./cases/headers.cjs'),
  require('./cases/basic-auth.cjs'),
  require('./cases/bearer-auth.cjs'),
  require('./cases/whitelist-allow.cjs'),
  require('./cases/whitelist-deny.cjs'),
  require('./cases/https-only.cjs'),
  require('./cases/tcp.cjs'),
  require('./cases/udp.cjs'),
  require('./cases/config-roundtrip.cjs'),
  require('./cases/debugger-ws.cjs'),
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
