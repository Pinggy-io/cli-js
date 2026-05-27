const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
  sleep,
} = require('../lib/framework.cjs');

function readConfig(name) {
  const dir = sandbox.tunnelsConfigDir();
  const match = fs.readdirSync(dir).find((f) => f.startsWith(name + '_') && f.endsWith('.json'));
  if (!match) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, match), 'utf-8'));
}

module.exports = {
  name: 'config-update',
  async run() {
    sandbox.reset();

    const save = await runSubcommand(['config', 'save', 'updcfg', '-l', '3000']);
    if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

    const before = readConfig('updcfg');
    if (!before) throw new Error('config not on disk after save');

    await sleep(1100);

    const upd = await runSubcommand(['config', 'update', 'updcfg', '-l', '4000']);
    if (upd.code !== 0) throw new Error(`update exit=${upd.code}: ${upd.combined.slice(0, 400)}`);
    if (!/updated/i.test(upd.combined)) throw new Error(`expected "updated" message: ${upd.combined.slice(0, 400)}`);

    const after = readConfig('updcfg');
    if (!after) throw new Error('config missing after update');
    if (after.configId !== before.configId) throw new Error(`configId changed: ${before.configId} -> ${after.configId}`);
    if (after.createdAt !== before.createdAt) throw new Error(`createdAt changed: ${before.createdAt} -> ${after.createdAt}`);
    if (after.updatedAt === before.updatedAt) throw new Error(`updatedAt did not change`);

    const fwd = JSON.stringify(after.tunnelConfig.forwarding);
    if (!/4000/.test(fwd)) throw new Error(`updated forwarding does not show port 4000: ${fwd}`);
    if (/3000/.test(fwd)) throw new Error(`updated forwarding still references port 3000: ${fwd}`);
  },
};
