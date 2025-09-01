export const cliOptions = {
  port: { type: 'string' as const, short: 'p', description: 'Pinggy server port. Default: 443' },
  token: { type: 'string' as const, short: 't', description: 'Token for authentication. Eg. --token TOKEN_VALUE' },
  type: { type: 'string' as const, description: 'Type of the connection. Eg. --type tcp' },
  'basic-auth': { type: 'string' as const, short: 'b', multiple: true, description: 'Basic authentication (format: user:pass)' },
  'bearer-auth': { type: 'string' as const, short: 'k', multiple: true, description: 'Bearer token authentication' },
  ip: { type: 'string' as const, short: 'w', multiple: true, description: 'IP whitelist (CIDR format, e.g., 192.168.1.0/24)' },
  'extended-option': { type: 'string' as const, short: 'x', multiple: true, description: 'Extended options (e.g., https, localservertls:host)' },
  R: { type: 'string' as const, multiple: true, description: 'Local port. Eg. -R0:localhost:3000 will forward tunnel connections to local port 3000.' },
  L: { type: 'string' as const, multiple: true, description: 'Port for web debugger. Eg. --debugger 4300 OR -d 4300' },
  o: { type: 'string' as const, multiple: true, description: 'Extra options like ssh -o (e.g., ServerAliveInterval=30)' },
  help: { type: 'boolean' as const, short: 'h', description: 'Show this help message' },
} as const;

export type CliOptions = typeof cliOptions;
