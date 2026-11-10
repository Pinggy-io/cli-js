const fs = require('fs');
const { sandbox, getBinary, runSubcommand, startDaemon, stopDaemon, readDaemonInfo } = require('../lib/framework.cjs');
const { binaryVersion, bumpPatch, readUpdateState, runBinary, startFakeReleases, updateStatePath } = require('../lib/updates.cjs');

// `pinggy update --check` against a local release server: read-only, through the strict parser.
module.exports = {
  name: 'update-check',
  async run() {
    sandbox.reset();
    const version = binaryVersion(getBinary());
    const next = bumpPatch(version);
    const server = await startFakeReleases();
    const env = { PINGGY_UPDATE_RELEASES_URL: server.releasesUrl };

    try {
      // A newer release that has not finished building.
      server.setLatest(`v${next}`);
      let result = await runSubcommand(['update', '--check'], { env });
      if (result.code !== 1 || !result.combined.includes(`Release v${next} is not ready`)) {
        throw new Error(`a release with no SHA256SUMS should report not ready; exit=${result.code}: ${result.combined}`);
      }
      if (fs.existsSync(updateStatePath(sandbox))) throw new Error('not ready must write no update.json');

      // A finished release.
      server.setFile(`v${next}`, 'SHA256SUMS', Buffer.from('x'));
      result = await runSubcommand(['update', '--check'], { env });
      if (result.code !== 0 || !result.combined.includes(`pinggy ${next} is available. You run ${version}.`) || !result.combined.includes('Run: ')) {
        throw new Error(`a newer release should print the available line; exit=${result.code}: ${result.combined}`);
      }
      const state = readUpdateState(sandbox);
      if (state.latestVersion !== next || typeof state.latestSeenEpochSeconds !== 'number' || 'lastCheckEpochSeconds' in state) {
        throw new Error(`--check wrote the wrong fields: ${JSON.stringify(state)}`);
      }

      // The same version.
      server.setLatest(`v${version}`);
      result = await runSubcommand(['update', '--check'], { env });
      if (result.code !== 0 || !result.combined.includes(`pinggy ${version} is up to date.`)) {
        throw new Error(`the same version should be up to date; exit=${result.code}: ${result.combined}`);
      }

      // The strict parser and the usage line.
      result = await runSubcommand(['update', '--bogus'], { env });
      if (result.code === 0) throw new Error('an unknown flag should fail');
      result = await runSubcommand(['update', 'extra'], { env });
      if (result.code !== 1 || !result.combined.includes('Usage: pinggy update')) {
        throw new Error(`an extra argument should print usage; exit=${result.code}: ${result.combined}`);
      }

      // Offline.
      await server.close();
      result = await runSubcommand(['update', '--check'], { env });
      if (result.code !== 1 || !result.combined.includes('Could not reach GitHub')) {
        throw new Error(`offline should report it; exit=${result.code}: ${result.combined}`);
      }

      const ipc = runBinary(getBinary(), ['--_ipc-version']);
      if (ipc.code !== 0 || !/^\d+\s*$/.test(ipc.stdout)) throw new Error(`--_ipc-version printed: ${ipc.combined}`);

      if (!runBinary(getBinary(), ['--help']).stdout.includes('pinggy update')) throw new Error('--help does not list pinggy update');

      await startDaemon();
      try {
        const info = readDaemonInfo();
        if (info.cliVersion !== version) throw new Error(`daemon.json cliVersion is ${info.cliVersion}, expected ${version}`);
      } finally {
        await stopDaemon();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  },
};
