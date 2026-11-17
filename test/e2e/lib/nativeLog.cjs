const fs = require('fs');
const path = require('path');

// A libpinggy line: "<time>:: <file>:<line> (<pid>)::DEBUG::  <message>".
const NATIVE_LINE = /\(\d+\)::(DEBUG|INFO|ERROR|FATAL)::/;

function nativeLineCount(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf-8').split('\n').filter((line) => NATIVE_LINE.test(line)).length;
}

/**
 * With 2 or more tunnels running: libpinggy's lines for all of them are in libpinggy/libpinggy.log
 * and in no tunnel log, and POST /config/tunnel-logging stops and resumes them on running tunnels.
 * `url` is a tunnel URL: a request through it makes libpinggy log.
 */
async function checkNativeLog({ sandbox, ipcRequest, fetchJson, sleep, url, fail }) {
  const libLog = path.join(sandbox.pinggyLogDir(), 'libpinggy', 'libpinggy.log');
  const started = nativeLineCount(libLog);
  if (started === 0) fail(`no libpinggy lines in ${libLog}`);

  const tunnelDir = sandbox.tunnelLogDir();
  for (const file of fs.readdirSync(tunnelDir)) {
    const count = nativeLineCount(path.join(tunnelDir, file));
    if (count > 0) fail(`${count} libpinggy lines in tunnel log ${file}; they belong in libpinggy.log`);
  }

  const setLogging = async (enabled) => {
    const res = await ipcRequest('POST', '/config/tunnel-logging', { enabled });
    if (res.status !== 200 || res.json.enabled !== enabled) fail(`tunnel-logging ${enabled}: status=${res.status} body=${res.text.slice(0, 300)}`);
  };
  const countAfterRequest = async (atLeast) => {
    await fetchJson(url);
    let count = nativeLineCount(libLog);
    for (let i = 0; i < 20 && count < atLeast; i++) {
      await sleep(250);
      count = nativeLineCount(libLog);
    }
    return count;
  };

  // The request must log while on, or the "off" check below would pass for the wrong reason.
  const before = nativeLineCount(libLog);
  const whileOn = await countAfterRequest(before + 1);
  if (whileOn <= before) fail(`a request through the tunnel wrote no libpinggy line (${before} lines)`);

  await setLogging(false);
  try {
    await fetchJson(url);
    await sleep(1500);
    const whileOff = nativeLineCount(libLog);
    if (whileOff !== whileOn) fail(`libpinggy.log grew from ${whileOn} to ${whileOff} lines with tunnel logging off`);
  } finally {
    await setLogging(true);
  }

  const resumed = await countAfterRequest(whileOn + 1);
  if (resumed <= whileOn) fail(`libpinggy.log did not grow after tunnel logging was turned back on (${whileOn} lines)`);
}

module.exports = { checkNativeLog };
