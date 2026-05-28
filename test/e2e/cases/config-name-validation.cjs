const fs = require('fs');
const {
  sandbox,
  runSubcommand,
} = require('../lib/framework.cjs');

module.exports = {
  name: 'config-name-validation',
  async run() {
    sandbox.reset();

    const reserved = await runSubcommand(['config', 'save', 'ps', '-l', '3000']);
    if (reserved.code === 0) {
      throw new Error(`expected nonzero exit for reserved name "ps"; got code=0, out=${reserved.combined.slice(0, 400)}`);
    }
    if (!/reserved/i.test(reserved.combined)) {
      throw new Error(`expected "reserved" in error; got: ${reserved.combined.slice(0, 400)}`);
    }

    const badchar = await runSubcommand(['config', 'save', 'foo!bar', '-l', '3000']);
    if (badchar.code === 0) {
      throw new Error(`expected nonzero exit for "foo!bar"; got code=0, out=${badchar.combined.slice(0, 400)}`);
    }
    if (!/alphanumeric|hyphens|underscores/i.test(badchar.combined)) {
      throw new Error(`expected char-class error; got: ${badchar.combined.slice(0, 400)}`);
    }

    const longName = 'a'.repeat(129);
    const tooLong = await runSubcommand(['config', 'save', longName, '-l', '3000']);
    if (tooLong.code === 0) {
      throw new Error(`expected nonzero exit for 129-char name; got code=0`);
    }
    if (!/128|exceed/i.test(tooLong.combined)) {
      throw new Error(`expected length error; got: ${tooLong.combined.slice(0, 400)}`);
    }

    const dir = sandbox.tunnelsConfigDir();
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      if (files.length > 0) {
        throw new Error(`invalid names should not create config files; found: ${files.join(', ')}`);
      }
    }
  },
};
