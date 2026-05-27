const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
} = require('../lib/framework.cjs');

function readConfig(name) {
  const dir = sandbox.tunnelsConfigDir();
  const match = fs.readdirSync(dir).find((f) => f.startsWith(name + '_') && f.endsWith('.json'));
  return match ? JSON.parse(fs.readFileSync(path.join(dir, match), 'utf-8')) : null;
}

module.exports = {
  name: 'config-auto-toggle',
  async run() {
    sandbox.reset();

    const save = await runSubcommand(['config', 'save', 'autocfg', '-l', '3000']);
    if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

    let cfg = readConfig('autocfg');
    if (cfg.autoStart !== false) throw new Error(`initial autoStart should be false, got ${cfg.autoStart}`);

    const on = await runSubcommand(['config', 'auto', 'autocfg']);
    if (on.code !== 0) throw new Error(`auto on exit=${on.code}: ${on.combined.slice(0, 400)}`);
    cfg = readConfig('autocfg');
    if (cfg.autoStart !== true) throw new Error(`autoStart should be true after auto; got ${cfg.autoStart}`);

    const off = await runSubcommand(['config', 'noauto', 'autocfg']);
    if (off.code !== 0) throw new Error(`noauto exit=${off.code}: ${off.combined.slice(0, 400)}`);
    cfg = readConfig('autocfg');
    if (cfg.autoStart !== false) throw new Error(`autoStart should be false after noauto; got ${cfg.autoStart}`);

    const saveAuto = await runSubcommand(['config', 'save', 'autocfg2', '-l', '3001', '--auto']);
    if (saveAuto.code !== 0) throw new Error(`save --auto failed: ${saveAuto.combined.slice(0, 400)}`);
    const cfg2 = readConfig('autocfg2');
    if (cfg2.autoStart !== true) throw new Error(`save --auto did not set autoStart=true; got ${cfg2.autoStart}`);
  },
};
