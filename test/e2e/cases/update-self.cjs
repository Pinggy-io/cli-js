const { sandbox, getBinary, SkipCase } = require('../lib/framework.cjs');
const {
  assetNameForHost,
  binaryVersion,
  installInSandbox,
  readUpdateState,
  runBinaryAsync,
  startFakeReleases,
  updateEnvironment,
} = require('../lib/updates.cjs');

// The release gate. An installed copy runs the updater it shipped with, so a later release cannot repair a broken one.
// The candidate must update itself to the next version, and the next version must run.
module.exports = {
  name: 'update-self',
  async run() {
    const nextBinary = process.env.PINGGY_E2E_NEXT_BINARY;
    if (!nextBinary) throw new SkipCase('PINGGY_E2E_NEXT_BINARY is not set');

    sandbox.reset();
    const candidateVersion = binaryVersion(getBinary());
    const nextVersion = binaryVersion(nextBinary);
    const server = await startFakeReleases();
    const env = updateEnvironment(server);

    try {
      const installed = installInSandbox(getBinary(), sandbox);
      server.publish(`v${nextVersion}`, assetNameForHost(), nextBinary);

      let result = await runBinaryAsync(installed, ['update'], env);
      if (result.code !== 0 || !result.combined.includes(`Updated pinggy ${candidateVersion} to ${nextVersion}.`)) {
        throw new Error(`update failed; exit=${result.code}: ${result.combined}`);
      }
      const reported = binaryVersion(installed);
      if (reported !== nextVersion) throw new Error(`the installed binary reports ${reported}, expected ${nextVersion}`);

      result = await runBinaryAsync(installed, ['ps'], env);
      if (result.code !== 0) throw new Error(`the new version does not run; exit=${result.code}: ${result.combined}`);

      result = await runBinaryAsync(installed, ['update'], env);
      if (!result.combined.includes(`pinggy ${nextVersion} is up to date.`) && !result.combined.includes(`pinggy ${candidateVersion} is up to date.`)) {
        throw new Error(`a 2nd update should find nothing to do; exit=${result.code}: ${result.combined}`);
      }

      result = await runBinaryAsync(installed, ['update', '--rollback'], env);
      if (result.code !== 0 || !result.combined.includes(`Rolled back pinggy ${nextVersion} to ${candidateVersion}.`)) {
        throw new Error(`rollback failed; exit=${result.code}: ${result.combined}`);
      }
      if (binaryVersion(installed) !== candidateVersion) throw new Error('rollback did not restore the old version');
      if (readUpdateState(sandbox).rolledBackFromVersion !== nextVersion) throw new Error('rollback did not record the version it left');

      // A release whose SHA256SUMS does not match its binary must be refused.
      server.setFile(`v${nextVersion}`, 'SHA256SUMS', Buffer.from(`${'0'.repeat(64)}  ${assetNameForHost()}\n`));
      result = await runBinaryAsync(installed, ['update'], env);
      if (result.code !== 1 || !result.combined.includes('failed its checksum')) {
        throw new Error(`a wrong checksum should be refused; exit=${result.code}: ${result.combined}`);
      }
      if (binaryVersion(installed) !== candidateVersion) throw new Error('a refused update changed the binary');
    } finally {
      await server.close();
    }
  },
};
