const fs = require('fs');
const { sandbox, getBinary, runSubcommand, withDaemon } = require('../lib/framework.cjs');
const { runUnderTerminal } = require('../lib/updates.cjs');

const OLD_VERSION = '0.0.1';

// A daemon left on an older build: the CLI says so once per version, and only in a terminal.
module.exports = {
  name: 'daemon-version-notice',
  async run() {
    await withDaemon(async () => {
      const infoPath = sandbox.daemonJsonPath();
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      fs.writeFileSync(infoPath, JSON.stringify({ ...info, cliVersion: OLD_VERSION }));
      const env = { PINGGY_AUTO_UPDATE: 'false' };

      const piped = await runSubcommand(['ps'], { env });
      if (piped.combined.includes('The daemon runs')) throw new Error(`a pipe must get no notice: ${piped.combined}`);

      const first = await runUnderTerminal(getBinary(), ['ps'], env);
      if (!first.output.includes(`The daemon runs ${OLD_VERSION}.`) || !first.output.includes('This stops all running tunnels.')) {
        throw new Error(`a terminal should get the notice: ${first.output}`);
      }

      const second = await runUnderTerminal(getBinary(), ['ps'], env);
      if (second.output.includes('The daemon runs')) throw new Error(`the notice printed twice: ${second.output}`);
    });
  },
};
