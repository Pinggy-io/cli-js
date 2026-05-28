const fs = require('fs');
const {
  sandbox,
  runSubcommand,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'config-delete',
  async run() {
    sandbox.reset();

    const save = await runSubcommand(['config', 'save', 'delcfg', '-l', '3000']);
    if (save.code !== 0) throw new Error(`save failed: ${save.combined.slice(0, 400)}`);

    const filesBefore = fs.readdirSync(sandbox.tunnelsConfigDir());
    if (!filesBefore.some((f) => f.startsWith('delcfg_'))) {
      throw new Error(`save did not create file: ${filesBefore.join(', ')}`);
    }

    const del = await runSubcommand(['config', 'delete', 'delcfg']);
    if (del.code !== 0) throw new Error(`delete exit=${del.code}: ${del.combined.slice(0, 400)}`);
    if (!/deleted/i.test(del.combined)) throw new Error(`expected "deleted" message: ${del.combined.slice(0, 400)}`);

    const filesAfter = fs.readdirSync(sandbox.tunnelsConfigDir());
    if (filesAfter.some((f) => f.startsWith('delcfg_'))) {
      throw new Error(`config file still present after delete: ${filesAfter.join(', ')}`);
    }

    const del2 = await runSubcommand(['config', 'delete', 'delcfg']);
    if (!/No config found/i.test(del2.combined)) {
      throw new Error(`second delete should report missing config; got: ${del2.combined.slice(0, 400)}`);
    }
  },
};
