import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { TunnelManager } from "../tunnel_manager/TunnelManager.js"



describe('TunnelManager', () => {
    let tunnelManager: TunnelManager;

    beforeEach(() => {
        // Reset singleton instance for each test
        // @ts-ignore - accessing private static for testing
        TunnelManager.instance = undefined;
        tunnelManager = TunnelManager.getInstance();

        // Clear all mocks
        jest.clearAllMocks();
    });

    describe('Singleton pattern', () => {
        test('getInstance returns the same instance', () => {
            const instance1 = TunnelManager.getInstance();
            const instance2 = TunnelManager.getInstance();

            expect(instance1).toBe(instance2);
        });
    });

    describe('createTunnel', () => {
        test('creates a tunnel with valid config', async () => {
            const config = {
                configid: 'test-config-id',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'] as string[],
            };

            const result = await tunnelManager.createTunnel(config);

            expect(result).toBeDefined();
            expect(result.tunnelConfig).toEqual({
                configid: 'test-config-id',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'],
            });
            expect(result.configWithForwarding?.forwarding).toBeInstanceOf(Object)
        });

        test('creates a tunnel with custom tunnelid', async () => {
            const config = {
                configid: 'test-config-id-2',
                tunnelid: 'custom-tunnel-id',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['tcp'] as string[],
            };

            const result = await tunnelManager.createTunnel(config);

            expect(result.tunnelid).toBe('custom-tunnel-id');
        });

        test('creates a tunnel with tunnelName', async () => {
            const config = {
                configid: 'test-config-id-3',
                tunnelName: 'My Test Tunnel',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'] as string[],
            };

            const result = await tunnelManager.createTunnel(config);

            expect(result.tunnelName).toBe('My Test Tunnel');
        });

        test('throws error for empty configid', async () => {
            const config = {
                configid: '',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'] as string[],
            };

            await expect(tunnelManager.createTunnel(config)).rejects.toThrow('Invalid configId');
        });

        test('throws error for whitespace-only configid', async () => {
            const config = {
                configid: '   ',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'] as string[],
            };

            await expect(tunnelManager.createTunnel(config)).rejects.toThrow('Invalid configId');
        });

        test('throws error for duplicate configid', async () => {
            const config = {
                configid: 'duplicate-config-id',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'] as string[],
            };

            await tunnelManager.createTunnel(config);

            await expect(tunnelManager.createTunnel(config)).rejects.toThrow(
                'Tunnel with configId "duplicate-config-id" already exists'
            );
        });

        test('creates tunnel with additional forwarding rules', async () => {
            const config = {
                configid: 'test-config-additional',
                token: 'test-token',
                forwarding: 'localhost:3000',
                tunnelType: ['http'] as string[],
                additionalForwarding: [
                    {
                        protocol: 'tcp' as const,
                        remoteDomain: 'api.example.com',
                        remotePort: 5555,
                        localDomain: 'localhost',
                        localPort: 6666,
                    },
                ],
            };

            const result = await tunnelManager.createTunnel(config);

            expect(result.additionalForwarding).toBeDefined();
            expect(result.additionalForwarding?.length).toBe(1);
            expect(result.additionalForwarding?.[0]).toEqual({
                protocol: 'tcp',
                remoteDomain: 'api.example.com',
                remotePort: 5555,
                localDomain: 'localhost',
                localPort: 6666,
            });
        });
    });
    
});