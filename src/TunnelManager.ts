import { pinggy, type PinggyOptions, type TunnelInstance } from "@pinggy/pinggy";

interface ManagedTunnel {
    tunnelId: string; // runtime tunnel identifier
    configId: string;
    instance: TunnelInstance;
}

export class TunnelManager {
    private tunnelsByTunnelId: Map<string, ManagedTunnel> = new Map();
    private tunnelsByConfigId: Map<string, ManagedTunnel> = new Map();

    /**
     * Create (but not start) a tunnel
     */
    createTunnel(config: PinggyOptions & { configId: string }): ManagedTunnel {
        const { configId } = config;
        if (this.tunnelsByConfigId.has(configId)) {
            throw new Error(`Tunnel with configId "${configId}" already exists`);
        }
        const tunnelId = crypto.randomUUID();
        const instance = pinggy.createTunnel(config);

        const managed: ManagedTunnel = {
            tunnelId,
            configId,
            instance
        }
        this.tunnelsByTunnelId.set(tunnelId, managed);
        this.tunnelsByConfigId.set(configId, managed);

        return managed;
    }

    /**
     * Start a tunnel that was created but not yet started
     */
    async startTunnel(tunnelId: string): Promise<string[]> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel with id "${tunnelId}" not found`);
        return await managed.instance.start();
    }

    /**
     * Stop a tunnel by tunnelId
     */
    stopTunnel(tunnelId: string): void {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);

        managed.instance.stop();
        this.tunnelsByTunnelId.delete(tunnelId);
        this.tunnelsByConfigId.delete(managed.configId);
    }

    /**
     * Get all public URLs for a tunnel
     */
    getTunnelUrls(tunnelId: string): string[] {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        return managed.instance.urls();
    }

    /**
     * Get status of a tunnel
     */
    getTunnelStatus(tunnelId: string): string {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        return managed.instance.getStatus();
    }

    /**
     * Stop all tunnels
     */
    stopAllTunnels(): void {
        for (const { instance } of this.tunnelsByTunnelId.values()) {
            instance.stop();
        }
        this.tunnelsByTunnelId.clear();
        this.tunnelsByConfigId.clear();
    }

    getTunnelInstance(configId?: string, tunnelId?: string): TunnelInstance {
        if(configId){
            const managed = this.tunnelsByConfigId.get(configId);
            if (!managed) throw new Error(`Tunnel "${configId}" not found`);
            return managed.instance;
        }
        if(tunnelId){
            const managed = this.tunnelsByTunnelId.get(tunnelId);
            if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
            return managed.instance;
        }
        throw new Error(`Either configId or tunnelId must be provided`);
    }

    /**
     * Get tunnel config by tunnelId
     */
    getTunnelConfig(configId: string, tunnelId: string): PinggyOptions {
        if (configId) {
            const tunnelInstance = this.getTunnelInstance(configId);
            return <PinggyOptions>tunnelInstance.getConfig();
        }
        if (tunnelId) {
            const tunnelInstance = this.getTunnelInstance(tunnelId);
            return <PinggyOptions>tunnelInstance.getConfig();
        }
        throw new Error(`Either configId or tunnelId must be provided`);
    }

}
