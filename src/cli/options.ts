export const cliOptions = {
  // SSH-like options
  R: { type: 'string' as const, multiple: true, description: 'Local port. Eg. -R0:localhost:3000 will forward tunnel connections to local port 3000.' },
  L: { type: 'string' as const, multiple: true, description: 'Web Debugger address. Eg. -L4300:localhost:4300 will start web debugger on port 4300.' },
  o: { type: 'string' as const, multiple: true, description: 'Options', hidden: true },
  'server-port': { type: 'string' as const, short: 'p', description: 'Pinggy server port. Default: 443' },

  v4: { type: 'boolean' as const, short: '4', description: 'IPv4 only', hidden: true },
  v6: { type: 'boolean' as const, short: '6', description: 'IPv6 only', hidden: true },

  // These options appear in the ssh command, but we ignore it in CLI
  t: { type: 'boolean' as const, description: 'hidden', hidden: true },
  T: { type: 'boolean' as const, description: 'hidden', hidden: true },
  n: { type: 'boolean' as const, description: 'hidden', hidden: true },
  N: { type: 'boolean' as const, description: 'hidden', hidden: true },

  // Better options
  type: { type: 'string' as const, description: 'Type of the connection. Eg. --type tcp' },
  localport: { type: 'string' as const, short: 'l', description: 'Takes input as [protocol:][host:]port. Eg. --localport https://localhost:8000 OR -l 3000' },
  debugger: { type: 'string' as const, short: 'd', description: 'Port for web debugger. Eg. --debugger 4300 OR -d 4300' },
  token: { type: 'string' as const, description: 'Token for authentication. Eg. --token TOKEN_VALUE' },

  // Logging options (CLI overrides env)
  loglevel: { type: 'string' as const, description: 'Logging level: ERROR, INFO, DEBUG. Overrides PINGGY_LOG_LEVEL environment variable' },
  logfile: { type: 'string' as const, description: 'Path to log file. Overrides PINGGY_LOG_FILE environment variable' },
  v: { type: 'boolean' as const, description: 'Print logs to stdout for Cli. Overrides PINGGY_LOG_STDOUT environment variable' },
  vv: { type: 'boolean' as const, description: 'Enable detailed logging for the Node.js SDK and Libpinggy, including both info and debug level logs.' },
  vvv: { type: 'boolean' as const, description: 'Enable all logs from Cli, SDK and internal components.' },

  autoreconnect: { type: 'string' as const, short: 'a', description: 'Automatically reconnect tunnel on failure (enabled by default). Use -a false to disable.' },


  // Save and load config
  saveconf: { type: 'string' as const, description: 'Create the configuration file based on the options provided here' },
  conf: { type: 'string' as const, description: 'Use the configuration file as base. Other options will be used to override this file' },

  // File server
  serve: { type: 'string' as const, description: 'Start a webserver to serve files from the specified path. Eg --serve /path/to/files' },

  // Remote Control
  'remote-management': { type: 'string' as const, description: 'Enable remote management of tunnels with token. Eg. --remote-management API_KEY' },
  manage: { type: 'string' as const, description: 'Provide a server address to manage tunnels. Eg --manage dashboard.pinggy.io' },
  notui: { type: 'boolean' as const, description: 'Disable TUI in remote management mode' },
  // Misc
  version: { type: 'boolean' as const, description: 'Print version' },

  // Help
  help: { type: 'boolean' as const, short: 'h', description: 'Show this help message' },
} as const;

export type CliOptions = typeof cliOptions;
