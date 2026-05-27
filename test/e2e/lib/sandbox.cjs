const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function rm(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function createSandbox(rootDir) {
  const home = path.join(rootDir, 'home');
  fs.mkdirSync(home, { recursive: true });

  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };

  for (const dir of [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.APPDATA, env.LOCALAPPDATA]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function pinggyConfigDir() {
    if (isWindows) return path.join(env.APPDATA, 'pinggy');
    return path.join(env.XDG_CONFIG_HOME, 'pinggy');
  }
  function pinggyLogDir() {
    if (isWindows) return path.join(env.LOCALAPPDATA, 'Pinggy-CLI', 'Logs');
    if (isMac) return path.join(home, 'Library', 'Logs', 'Pinggy-CLI');
    return path.join(env.XDG_STATE_HOME, 'pinggy-cli', 'logs');
  }

  return {
    home,
    env,
    pinggyConfigDir,
    pinggyLogDir,
    daemonJsonPath: () => path.join(pinggyConfigDir(), 'daemon.json'),
    daemonStatePath: () => path.join(pinggyConfigDir(), 'daemon-state.json'),
    daemonConfigPath: () => path.join(pinggyConfigDir(), 'daemon-config.json'),
    tunnelsConfigDir: () => path.join(pinggyConfigDir(), 'tunnels'),
    daemonLogPath: () => path.join(pinggyLogDir(), 'daemon.log'),
    tunnelLogDir: () => path.join(pinggyLogDir(), 'tunnels'),
    reset() {
      rm(pinggyConfigDir());
      rm(pinggyLogDir());
    },
    cleanup() {
      rm(home);
    },
  };
}

module.exports = { createSandbox };
