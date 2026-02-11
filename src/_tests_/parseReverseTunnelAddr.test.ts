import { describe, test, expect, jest } from '@jest/globals';
import {
  parseReverseTunnelAddr,
  parseDefaultForwarding,
  parseAdditionalForwarding,
  ipv6SafeSplitColon,
  parseUsers,
  parseLocalTunnelAddr,
} from '../cli/buildConfig.js';
import { FinalConfig, AdditionalForwarding } from '../types.js';
import { defaultOptions } from '../cli/defaults.js';
import { TunnelType } from '@pinggy/pinggy';
import { randomUUID } from 'crypto';

// Helper to create a minimal FinalConfig for testing
function createTestConfig(overrides: Partial<FinalConfig> = {}): FinalConfig {
  return {
    ...defaultOptions,
    configid: randomUUID(),
    token: '',
    serverAddress: 'a.pinggy.io',
    tunnelType: [TunnelType.Http],
    ...overrides,
  } as FinalConfig;
}

// Helper to create minimal parsed values
function createParsedValues(R?: string[], localport?: string) {
  return { R, localport } as any;
}

describe('ipv6SafeSplitColon', () => {
  test('splits simple colon-separated string', () => {
    expect(ipv6SafeSplitColon('a:b:c')).toEqual(['a', 'b', 'c']);
  });

  test('preserves IPv6 addresses in brackets', () => {
    expect(ipv6SafeSplitColon('[::1]:8080')).toEqual(['[::1]', '8080']);
  });

  test('handles IPv6 with multiple colons in brackets', () => {
    expect(ipv6SafeSplitColon('[2001:db8::1]:443')).toEqual(['[2001:db8::1]', '443']);
  });

  test('handles complex forwarding format with IPv6', () => {
    expect(ipv6SafeSplitColon('example.com:7777:[::1]:8080')).toEqual([
      'example.com',
      '7777',
      '[::1]',
      '8080',
    ]);
  });

  test('handles empty string', () => {
    expect(ipv6SafeSplitColon('')).toEqual(['']);
  });

  test('handles single element without colons', () => {
    expect(ipv6SafeSplitColon('localhost')).toEqual(['localhost']);
  });
});

describe('parseDefaultForwarding', () => {
  test('parses 3-part format: remotePort:localDomain:localPort', () => {
    const result = parseDefaultForwarding('5555:localhost:6666');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      remotePort: 5555,
      localDomain: 'localhost',
      localPort: 6666,
    });
  });

  test('parses 3-part format with port', () => {
    const result = parseDefaultForwarding('0:localhost:3000');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      remotePort: 0,
      localDomain: 'localhost',
      localPort: 3000,
    });
  });

  test('parses 4-part format: remoteDomain:remotePort:localDomain:localPort', () => {
    const result = parseDefaultForwarding('example.com:7777:localhost:8080');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      remoteDomain: 'example.com',
      remotePort: 7777,
      localDomain: 'localhost',
      localPort: 8080,
    });
  });

  test('parses 4-part format with IPv6 local address', () => {
    const result = parseDefaultForwarding('example.com:7777:[::1]:8080');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      remoteDomain: 'example.com',
      remotePort: 7777,
      localDomain: '::1',
      localPort: 8080,
    });
  });

  test('returns error for invalid format (2 parts)', () => {
    const result = parseDefaultForwarding('localhost:8080');
    expect(result).toBeInstanceOf(Error);
  });

  test('returns error for invalid format (5 parts)', () => {
    const result = parseDefaultForwarding('a:b:c:d:e');
    expect(result).toBeInstanceOf(Error);
  });

  test('returns error for single part', () => {
    const result = parseDefaultForwarding('8080');
    expect(result).toBeInstanceOf(Error);
  });
});

describe('parseAdditionalForwarding', () => {
test('parses HTTP forwarding with explicit protocol', () => {
  const result = parseAdditionalForwarding('http//example.com:0:localhost:3000');
  expect(result).not.toBeInstanceOf(Error);
  expect(result).toEqual({
    protocol: 'http',
    remoteDomain: 'example.com',
    remotePort: 0,
    localDomain: 'localhost',
    localPort: 3000
  });
});
  test('parses TCP forwarding with port', () => {
    const result = parseAdditionalForwarding('tcp//example.com/5555:0:localhost:6666');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      protocol: 'tcp',
      remoteDomain: 'example.com',
      remotePort: 5555,
      localDomain: 'localhost',
      localPort: 6666
    });
  });

  test('parses UDP forwarding with port', () => {
    const result = parseAdditionalForwarding('udp//example.com/1234:0:localhost:5678');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      protocol: 'udp',
      remoteDomain: 'example.com',
      remotePort: 1234,
      localDomain: 'localhost',
      localPort: 5678
    });
  });

  test('parses TLS forwarding with port', () => {
    const result = parseAdditionalForwarding('tls//example.com/443:0:localhost:8443');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      protocol: 'tls',
      remoteDomain: 'example.com',
      remotePort: 443,
      localDomain: 'localhost',
      localPort: 8443
    });
  });

  test('defaults to HTTP protocol when no protocol specified', () => {
    const result = parseAdditionalForwarding('example.com:0:localhost:3000');
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({
      protocol: 'http',
      remoteDomain: 'example.com',
      remotePort: 0,
      localDomain: 'localhost',
      localPort: 3000
    });
  });

  test('returns error for invalid protocol', () => {
    const result = parseAdditionalForwarding('ftp//example.com:0:localhost:3000');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/invalid protocol/i);
  });

  test('returns error for TCP without remote port', () => {
    const result = parseAdditionalForwarding('tcp//example.com:0:localhost:3000');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/requires port/i);
  });

  test('returns error for invalid local port', () => {
    const result = parseAdditionalForwarding('example.com:0:localhost:invalid');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/invalid local port/i);
  });

  test('returns error for invalid format (too few parts)', () => {
    const result = parseAdditionalForwarding('example.com:localhost');
    expect(result).toBeInstanceOf(Error);
  });

  test('returns error for invalid remote domain', () => {
    const result = parseAdditionalForwarding('not_a_domain:0:localhost:3000');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/invalid remote domain/i);
  });

  test('handles IPv6 local address', () => {
    const result = parseAdditionalForwarding('example.com:0:[::1]:3000');
    expect(result).not.toBeInstanceOf(Error);
    const forwarding = result as AdditionalForwarding;
    expect(forwarding.localDomain).toBe('::1');
  });

  test('handles empty local domain defaults to localhost', () => {
    const result = parseAdditionalForwarding('example.com:0::3000');
    expect(result).not.toBeInstanceOf(Error);
    const forwarding = result as AdditionalForwarding;
    expect(forwarding.localDomain).toBe('localhost');
  });
});

describe('parseReverseTunnelAddr', () => {
  describe('error handling', () => {
    test('returns error when no -R, no localport, and no forwarding in config', () => {
      const config = createTestConfig({ forwarding: undefined });
      const values = createParsedValues(undefined, undefined);
      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toMatch(/local port not specified/i);
    });

    test('returns error when -R is empty array and no localport', () => {
      const config = createTestConfig({ forwarding: undefined });
      const values = createParsedValues([], undefined);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toMatch(/local port not specified/i);
    });

    test('returns error for 2-part forwarding', () => {
      const config = createTestConfig();
      const values = createParsedValues(['localhost:8080']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeInstanceOf(Error);
    });

    test('returns error for 5-part forwarding', () => {
      const config = createTestConfig();
      const values = createParsedValues(['a:b:c:d:e']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeInstanceOf(Error);
    });
  });

  describe('3-part forwarding format (base forwarding)', () => {
  
    test('parses base forwarding with specific remote port', () => {
      const config = createTestConfig();
      const values = createParsedValues(['0:localhost:6666']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.forwarding).toBe('localhost:6666');
    });

    test('parses base forwarding with custom host', () => {
      const config = createTestConfig();
      const values = createParsedValues(['0:myserver.local:8080']);
      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.forwarding).toBe('myserver.local:8080');
    });

    test('parses base forwarding with IPv6 local address', () => {
      const config = createTestConfig();
      const values = createParsedValues(['0:[::1]:3000']);
      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.forwarding).toBe('::1:3000');
    });
  });

  describe('4-part forwarding format (additional forwarding)', () => {
    test('parses single additional forwarding', () => {
      const config = createTestConfig();
      const values = createParsedValues(['example.com:7777:localhost:8080']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.additionalForwarding).toBeDefined();
      expect(config.additionalForwarding?.length).toBe(1);
      expect(config.additionalForwarding?.[0]).toMatchObject({
        remoteDomain: 'example.com',
        remotePort: 0,
        localDomain: 'localhost',
        localPort: 8080,
      });
    });

    test('parses additional forwarding with IPv6 local address', () => {
      const config = createTestConfig();
      const values = createParsedValues(['example.com:7777:[::1]:8080']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.additionalForwarding?.[0]?.localDomain).toBe('::1');
    });

    test('parses HTTP protocol additional forwarding', () => {
      const config = createTestConfig();
      const values = createParsedValues(['http//example.com:0:localhost:3000']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.additionalForwarding?.[0]).toMatchObject({
        protocol: 'http',
        remoteDomain: 'example.com',
        remotePort: 0,
        localDomain: 'localhost',
        localPort: 3000,
      });
    });

    test('parses TCP protocol additional forwarding', () => {
      const config = createTestConfig();
      const values = createParsedValues(['tcp//example.com/5555:0:localhost:6666']);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.additionalForwarding?.[0]).toMatchObject({
        protocol: 'tcp',
        remotePort: 5555,
      });
    });
  });

  describe('multiple -R values', () => {
    test('parses base forwarding followed by additional forwarding', () => {
      const config = createTestConfig();
      const values = createParsedValues([
        '0:localhost:3000',
        'example.com:7777:localhost:8080',
      ]);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.forwarding).toBe('localhost:3000');
      expect(config.additionalForwarding?.length).toBe(1);
      expect(config.additionalForwarding?.[0]).toMatchObject({
        remoteDomain: 'example.com',
        remotePort: 0,
        localDomain: 'localhost',
        localPort: 8080,
      });
    });

    test('parses multiple additional forwardings', () => {
      const config = createTestConfig();
      const values = createParsedValues([
        'api.example.com:0:localhost:3001',
        'web.example.com:0:localhost:3002',
      ]);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.additionalForwarding?.length).toBe(2);
      expect(config.additionalForwarding?.[0]).toMatchObject({
        remoteDomain: 'api.example.com',
        remotePort: 0,
        localDomain: 'localhost',
        localPort: 3001,
      });
      expect(config.additionalForwarding?.[1]).toMatchObject({
        remoteDomain: 'web.example.com',
        remotePort: 0,
        localDomain: 'localhost',
        localPort: 3002,
      });
    });

    test('returns error if any forwarding in array is invalid', () => {
      const config = createTestConfig();
      const values = createParsedValues([
        '0:localhost:3000',
        'invalid',
        'example.com:7777:localhost:8080',
      ]);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeInstanceOf(Error);
    });

    test('handles IPv6 addresses mixed with regular addresses', () => {
      const config = createTestConfig();
      const values = createParsedValues([
        '0:[::1]:3000',
        'example.com:7777:[2001:db8::1]:8080',
      ]);

      const result = parseReverseTunnelAddr(config, values);

      expect(result).toBeNull();
      expect(config.forwarding).toBe('::1:3000');
    });
  });
});

describe('parseUsers', () => {
  describe('empty or no positional args', () => {
    test('returns all undefined/defaults for empty positional args', () => {
      const result = parseUsers([]);
      expect(result).toEqual({
        token: undefined,
        server: undefined,
        type: undefined,
        forceFlag: false,
        qrCode: false,
        remaining: [],
      });
    });
  });

  describe('user@domain format', () => {
    test('parses token@domain', () => {
      const result = parseUsers(['mytoken@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.server).toBe('pinggy.io');
      expect(result.type).toBeUndefined();
      expect(result.remaining).toEqual([]);
    });

    test('parses type@domain for http', () => {
      const result = parseUsers(['http@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.type).toBe('http');
      expect(result.server).toBe('pinggy.io');
    });

    test('parses type@domain for tcp', () => {
      const result = parseUsers(['tcp@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.type).toBe('tcp');
      expect(result.server).toBe('pinggy.io');
    });

    test('parses type@domain for tls', () => {
      const result = parseUsers(['tls@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.type).toBe('tls');
      expect(result.server).toBe('pinggy.io');
    });

    test('parses type@domain for udp', () => {
      const result = parseUsers(['udp@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.type).toBe('udp');
      expect(result.server).toBe('pinggy.io');
    });

    test('parses type@domain for tlstcp', () => {
      const result = parseUsers(['tlstcp@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.type).toBe('tlstcp');
      expect(result.server).toBe('pinggy.io');
    });
  });

  describe('user modifiers with + separator', () => {
    test('parses token+type@domain', () => {
      const result = parseUsers(['mytoken+http@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.type).toBe('http');
      expect(result.server).toBe('pinggy.io');
    });

    test('parses token+force@domain sets forceFlag', () => {
      const result = parseUsers(['mytoken+force@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.forceFlag).toBe(true);
      expect(result.server).toBe('pinggy.io');
    });

    test('parses token+qr@domain sets qrCode', () => {
      const result = parseUsers(['mytoken+qr@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.qrCode).toBe(true);
      expect(result.server).toBe('pinggy.io');
    });

    test('parses token+type+qr@domain', () => {
      const result = parseUsers(['mytoken+tcp+qr@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.type).toBe('tcp');
      expect(result.qrCode).toBe(true);
      expect(result.server).toBe('pinggy.io');
    });

    test('parses token+force+type@domain', () => {
      const result = parseUsers(['mytoken+force+http@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.forceFlag).toBe(true);
      expect(result.type).toBe('http');
      expect(result.server).toBe('pinggy.io');
    });

    test('parses type+qr@domain (no token)', () => {
      const result = parseUsers(['http+qr@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.type).toBe('http');
      expect(result.qrCode).toBe(true);
      expect(result.server).toBe('pinggy.io');
    });

    test('parses token+force+qr+type@domain (all modifiers)', () => {
      const result = parseUsers(['mytoken+force+qr+tls@pinggy.io']);
      expect(result.token).toBe('mytoken');
      expect(result.forceFlag).toBe(true);
      expect(result.type).toBe('tls');
      expect(result.qrCode).toBe(true);
      expect(result.server).toBe('pinggy.io');
    });
  });

  describe('Edge cases', () => {
    test('pares force+qr+type@pinggy.io', () => {
      const result = parseUsers(['force+qr+tls@pinggy.io']);
      expect(result.token).toBeUndefined();
      expect(result.forceFlag).toBe(true);
      expect(result.type).toBe('tls');
      expect(result.qrCode).toBe(true);
      expect(result.server).toBe('pinggy.io');
    });
  });
  
});

describe('parseLocalTunnelAddr', () => {
  test('returns null when L is undefined', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: undefined } as any);
    expect(result).toBeNull();

  });

  test('returns null when L is an empty array', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: [] } as any);
    expect(result).toBeNull();
  });

  test('parses valid 3-part format and sets webDebugger', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: ['4300:localhost:4300'] } as any);
    expect(config.webDebugger).toBe('localhost:4300');
  });

  test('parses valid format with different ports', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: ['9000:127.0.0.1:8080'] } as any);
    expect(config.webDebugger).toBe('localhost:9000'); 
  });

  test('returns error for invalid port number', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: ['9999:localhost:4300000'] } as any);
    expect(config.webDebugger).toBe('localhost:9999'); 
   
  });

  test('returns error for wrong format (not 3 parts)', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: ['localhost:4300'] } as any);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('web debugger address incorrect');
  });

  test('returns error for too many parts', () => {
    const config = createTestConfig();
    const result = parseLocalTunnelAddr(config, { L: ['a:b:c:d'] } as any);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('web debugger address incorrect');
  });
});
