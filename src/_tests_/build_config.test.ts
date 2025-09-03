import { buildFinalConfig } from '../cli/buildConfig';


describe('buildFinalConfig', () => {
  test('throws when -R is not provided', () => {
    expect(() => buildFinalConfig({ R: [] }, [])).toThrow(/local port not specified/i);
  });

  test('parses -R with base forwarding and additional forwardings (including IPv6)', () => {
    const values = {
      R: [
        '0:localhost:3000',
        '5555:localhost:6666',
        'example.com:7777:[::1]:8080',
      ]
    };
    const cfg = buildFinalConfig(values, []);

    expect(cfg.forwardTo).toBe('localhost:3000');
    expect(cfg.additionalForwarding).toBeDefined();
    expect(cfg.additionalForwarding!.length).toBe(2);
    expect(cfg.additionalForwarding![0]).toEqual({
      remotePort: 5555,
      localDomain: 'localhost',
      localPort: 6666,
    });
    expect(cfg.additionalForwarding![1]).toEqual({
      remoteDomain: 'example.com',
      remotePort: 7777,
      localDomain: '::1',
      localPort: 8080,
    });
  });

  test('parses --localport with https scheme and host:port (sets SNI but base forwardTo comes from -R)', () => {
    const values = { R: ['0:localhost:3000'], localport: 'https://myhost.local:8443' };
    const cfg = buildFinalConfig(values, []);
    // Because -R is present, forwardTo is derived from the first -R entry
    expect(cfg.forwardTo).toBe('localhost:3000');
    // localServerTls should still be set from localport's host
    expect(cfg.localServerTls).toBe('myhost.local');
  });

  test('parses token@domain for server and token; type from explicit --type', () => {
    const positionals: string[] = [];
    const values = { R: ['0:localhost:22'], token: 'mytoken@ap.example.com', type: 'tcp' };

    const cfg = buildFinalConfig(values, positionals);
    expect(cfg.type).toBe('tcp');
    expect(cfg.serverAddress).toBe('ap.example.com');
    expect(cfg.token).toBe('mytoken');
  });

  test('extended options: x:, w:, b:, k:, a:, u:, r:', () => {
    const values = { R: ['0:localhost:3000'] };
    const cfg = buildFinalConfig(values, [
      'x:https',
      'x:xff',
      'w:192.168.1.0/24',
      'b:user:pass',
      'k:BEARER1',
      'a:X-Test:One',
      'u:X-Test:Two',
      'r:X-Remove',
    ]);

    expect(cfg.httpsOnly).toBe(true);
    expect(cfg.xff).toBe(true);
    expect(cfg.ipWhitelist).toEqual(['192.168.1.0/24']);
    expect(cfg.basicAuth).toEqual({ user: 'pass' });
    expect(cfg.bearerAuth).toContain('BEARER1');
    // Header modifications consist of add, update, remove entries
    expect(cfg.headerModification).toEqual(
      expect.arrayContaining([
        { action: 'add', key: 'X-Test', value: 'One' },
        { action: 'update', key: 'X-Test', value: 'Two' },
        { action: 'remove', key: 'X-Remove' },
      ]),
    );
  });

  test('invalid localport format throws error', () => {
    const values = { R: ['0:localhost:3000'], localport: 'bad:format:123:456' };
    expect(() => buildFinalConfig(values, [])).toThrow(/invalid --localport format/i);
  });

  test('invalid additional forwarding throws error', () => {
    const values = { R: ['0:localhost:3000', 'abc'] };
    expect(() => buildFinalConfig(values, [])).toThrow(/forwarding address incorrect/i);
  });
});
