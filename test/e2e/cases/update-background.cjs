const fs = require('fs');
const path = require('path');
const { sandbox, getBinary, runSubcommand, startDaemon, stopDaemon, SkipCase } = require('../lib/framework.cjs');
const {
  assetNameForHost,
  binaryVersion,
  installInSandbox,
  readUpdateState,
  runUnderTerminal,
  startFakeReleases,
  updateEnvironment,
  updateStatePath,
  waitFor,
} = require('../lib/updates.cjs');

const MAX_EXTRA_MILLIS = 1000;

function lockPath() {
  return path.join(sandbox.pinggyConfigDir(), 'update.lock');
}

function updaterHasLogged() {
  try {
    return fs.readFileSync(path.join(sandbox.pinggyLogDir(), 'update.log'), 'utf-8').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * The updater outlives the command, so the next step must not reset the sandbox under it. The lock alone cannot show
 * this, because it does not exist yet while the updater is still starting.
 */
async function updaterFinished() {
  await waitFor(() => updaterHasLogged() && !fs.existsSync(lockPath()), { maxMs: 30000, what: 'the updater exit' });
}

async function shortCommandDoesNotWait(server, env) {
  sandbox.reset();
  const baseline = await runUnderTerminal(getBinary(), ['config', 'list'], { ...env, PINGGY_AUTO_UPDATE: 'false' });
  server.setHang(true);
  try {
    const withUpdate = await runUnderTerminal(getBinary(), ['config', 'list'], env);
    if (withUpdate.elapsedMs > baseline.elapsedMs + MAX_EXTRA_MILLIS) {
      throw new Error(`the command waited for the updater: ${withUpdate.elapsedMs} ms against ${baseline.elapsedMs} ms`);
    }
    if (typeof readUpdateState(sandbox)?.lastAttemptEpochSeconds !== 'number') {
      throw new Error('the command should record its attempt before it starts the updater');
    }
  } finally {
    server.setHang(false);
    server.dropConnections();
  }
  await updaterFinished();
}

async function pipedCommandStartsNothing(env) {
  sandbox.reset();
  await runSubcommand(['config', 'list'], { env });
  if (fs.existsSync(updateStatePath(sandbox))) throw new Error('a piped command must not start the updater');
}

async function daemonStartsNothing() {
  sandbox.reset();
  await startDaemon();
  try {
    if (fs.existsSync(updateStatePath(sandbox))) throw new Error('a daemon start must not start the updater');
  } finally {
    await stopDaemon();
  }
}

async function updateFinishesAfterTheCommandExits(server, env, nextBinary) {
  sandbox.reset();
  const installed = installInSandbox(getBinary(), sandbox);
  const candidateVersion = binaryVersion(installed);
  const nextVersion = binaryVersion(nextBinary);
  server.publish(`v${nextVersion}`, assetNameForHost(), nextBinary);

  await runUnderTerminal(installed, ['config', 'list'], env);
  await waitFor(() => binaryVersion(installed) === nextVersion, { what: 'the background swap' });
  await waitFor(() => readUpdateState(sandbox)?.updatedToVersion === nextVersion, { what: 'the record of the update' });
  await updaterFinished();

  const first = await runUnderTerminal(installed, ['config', 'list'], env);
  if (!first.output.includes(`Updated pinggy ${candidateVersion} to ${nextVersion}.`)) {
    throw new Error(`the next start should print the Updated line: ${first.output}`);
  }
  const second = await runUnderTerminal(installed, ['config', 'list'], env);
  if (second.output.includes('Updated pinggy')) throw new Error(`the Updated line printed twice: ${second.output}`);
}

// The background update: the command never waits for it, and only a terminal starts it.
module.exports = {
  name: 'update-background',
  async run() {
    const server = await startFakeReleases();
    const env = updateEnvironment(server);
    try {
      server.setLatest('v0.0.1');
      await shortCommandDoesNotWait(server, env);
      await pipedCommandStartsNothing(env);
      await daemonStartsNothing();

      const nextBinary = process.env.PINGGY_E2E_NEXT_BINARY;
      if (!nextBinary) throw new SkipCase('the swap half needs PINGGY_E2E_NEXT_BINARY');
      await updateFinishesAfterTheCommandExits(server, env, nextBinary);
    } finally {
      await server.close();
    }
  },
};
