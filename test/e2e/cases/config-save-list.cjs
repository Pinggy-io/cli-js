const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'config-save-list',
  async run() {
    sandbox.reset();

    const save = await runSubcommand(['config', 'save', 'mycfg', '-l', '3000']);
    if (save.code !== 0) {
      throw new Error(`config save exit=${save.code}: ${save.combined.slice(0, 400)}`);
    }
    if (!/Config "mycfg" saved/i.test(save.combined)) {
      throw new Error(`expected save success message; got: ${save.combined.slice(0, 400)}`);
    }

    const files = fs.readdirSync(sandbox.tunnelsConfigDir());
    const match = files.find((f) => f.startsWith('mycfg_') && f.endsWith('.json'));
    if (!match) {
      throw new Error(`no mycfg_*.json file found in ${sandbox.tunnelsConfigDir()}: ${files.join(', ')}`);
    }

    const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox.tunnelsConfigDir(), match), 'utf-8'));
    if (onDisk.name !== 'mycfg') throw new Error(`saved name mismatch: ${onDisk.name}`);
    if (onDisk.autoStart !== false) throw new Error(`autoStart should default to false: ${onDisk.autoStart}`);
    if (!onDisk.configId) throw new Error('configId missing from saved file');
    if (!onDisk.tunnelConfig) throw new Error('tunnelConfig missing');

    const list = await runSubcommand(['config', 'list']);
    if (list.code !== 0) throw new Error(`config list exit=${list.code}: ${list.combined.slice(0, 400)}`);
    if (!/mycfg/.test(list.combined)) {
      throw new Error(`config list missing mycfg: ${list.combined.slice(0, 400)}`);
    }

    const show = await runSubcommand(['config', 'show', 'mycfg']);
    if (show.code !== 0) throw new Error(`config show exit=${show.code}: ${show.combined.slice(0, 400)}`);
    if (!/mycfg/.test(show.combined) || !/localhost:3000/.test(show.combined)) {
      throw new Error(`config show missing fields: ${show.combined.slice(0, 600)}`);
    }
  },
};
