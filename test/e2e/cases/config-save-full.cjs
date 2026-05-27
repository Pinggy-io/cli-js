const fs = require('fs');
const path = require('path');
const {
  sandbox,
  runSubcommand,
} = require('../lib/framework.cjs');

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label}: expected ${b}, got ${a}`);
  }
}

module.exports = {
  name: 'config-save-full',
  async run() {
    sandbox.reset();

    const save = await runSubcommand([
      'config', 'save', 'fullcfg',
      '-R0:localhost:80',
      '-Llocalhost:4300:localhost:4300',
      '-o', 'ServerAliveInterval=30',
      'force+qr@free.pinggy.io',
      'k:asdfasdfasdf',
      'x:https',
      'x:localServerTls:localhost',
      'x:passpreflight',
      'x:noreverseproxy',
      'x:xff',
      'x:fullurl',
      'a:x-pinggy-org:x-pinggy',
      'u:user-agent:user-good',
      'r:x-postman',
    ]);
    if (save.code !== 0) {
      throw new Error(`config save exit=${save.code}: ${save.combined.slice(0, 600)}`);
    }
    if (!/Config "fullcfg" saved/i.test(save.combined)) {
      throw new Error(`expected save success message; got: ${save.combined.slice(0, 600)}`);
    }

    const files = fs.readdirSync(sandbox.tunnelsConfigDir());
    const match = files.find((f) => f.startsWith('fullcfg_') && f.endsWith('.json'));
    if (!match) {
      throw new Error(`no fullcfg_*.json file found in ${sandbox.tunnelsConfigDir()}: ${files.join(', ')}`);
    }

    const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox.tunnelsConfigDir(), match), 'utf-8'));
    
    eq(onDisk.name, 'fullcfg', 'name');
    eq(onDisk.autoStart, false, 'autoStart');
    if (!onDisk.configId) throw new Error('configId missing from saved file');
    if (!onDisk.tunnelConfig) throw new Error('tunnelConfig missing');

    const tc = onDisk.tunnelConfig;

    eq(tc.serverAddress, 'free.pinggy.io', 'tunnelConfig.serverAddress');
    eq(tc.token, '', 'tunnelConfig.token');
    eq(tc.force, true, 'tunnelConfig.force');
    eq(tc.isQRCode, true, 'tunnelConfig.isQRCode');
    eq(tc.webDebugger, 'localhost:4300', 'tunnelConfig.webDebugger');
    eq(tc.httpsOnly, true, 'tunnelConfig.httpsOnly');
    eq(tc.allowPreflight, true, 'tunnelConfig.allowPreflight');
    eq(tc.reverseProxy, false, 'tunnelConfig.reverseProxy');
    eq(tc.xForwardedFor, true, 'tunnelConfig.xForwardedFor');
    eq(tc.originalRequestUrl, true, 'tunnelConfig.originalRequestUrl');

    deepEq(tc.bearerTokenAuth, ['asdfasdfasdf'], 'tunnelConfig.bearerTokenAuth');

    if (!Array.isArray(tc.forwarding) || tc.forwarding.length !== 1) {
      throw new Error(`forwarding shape wrong: ${JSON.stringify(tc.forwarding)}`);
    }
    deepEq(
      tc.forwarding[0],
      { address: 'https://localhost:80', type: 'http' },
      'tunnelConfig.forwarding[0]'
    );

    if (!Array.isArray(tc.headerModification) || tc.headerModification.length !== 3) {
      throw new Error(`headerModification shape wrong: ${JSON.stringify(tc.headerModification)}`);
    }
    deepEq(
      tc.headerModification[0],
      { type: 'add', key: 'x-sysmos-org', value: ['x-sysmos'] },
      'tunnelConfig.headerModification[0] (add)'
    );
    deepEq(
      tc.headerModification[1],
      { type: 'update', key: 'user-agent', value: ['user-good'] },
      'tunnelConfig.headerModification[1] (update)'
    );
    deepEq(
      tc.headerModification[2],
      { type: 'remove', key: 'x-postman', value: [] },
      'tunnelConfig.headerModification[2] (remove)'
    );

    const show = await runSubcommand(['config', 'show', 'fullcfg']);
    if (show.code !== 0) throw new Error(`config show exit=${show.code}: ${show.combined.slice(0, 600)}`);
    for (const needle of ['fullcfg', 'free.pinggy.io', 'localhost:80', 'localhost:4300']) {
      if (!show.combined.includes(needle)) {
        throw new Error(`config show missing "${needle}": ${show.combined.slice(0, 800)}`);
      }
    }
  },
};
