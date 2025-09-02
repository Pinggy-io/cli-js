import { pinggy, type PinggyOptions, type TunnelInstance } from "@pinggy/pinggy";
import { logger } from "./logger";

// Local representation of additional forwarding
interface AdditionalForwarding {
    remoteDomain?: string;
    remotePort: number;
    localDomain: string;
    localPort: number;
}

interface ManagedTunnel {
    tunnelId: string; // runtime tunnel identifier
    configId: string;
    instance: TunnelInstance;
    additionalForwarding?: AdditionalForwarding[];
}

export class TunnelManager {
    private tunnelsByTunnelId: Map<string, ManagedTunnel> = new Map();
    private tunnelsByConfigId: Map<string, ManagedTunnel> = new Map();

    /**
     * Create (but not start) a tunnel
     */
    createTunnel(config: (PinggyOptions & { configId: string }) & { additionalForwarding?: AdditionalForwarding[] }): ManagedTunnel {
        const { configId, additionalForwarding } = config;
        if (this.tunnelsByConfigId.has(configId)) {
            throw new Error(`Tunnel with configId "${configId}" already exists`);
        }
        const tunnelId = crypto.randomUUID();
        const instance = pinggy.createTunnel(config);

        const managed: ManagedTunnel = {
            tunnelId,
            configId,
            instance,
            additionalForwarding,
        }
        this.tunnelsByTunnelId.set(tunnelId, managed);
        this.tunnelsByConfigId.set(configId, managed);

        logger.info("Tunnel created", { configId, tunnelId });
        return managed;
    }

    /**
     * Start a tunnel that was created but not yet started
     */
    async startTunnel(tunnelId: string): Promise<string[]> {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel with id "${tunnelId}" not found`);
        logger.info("Starting tunnel", { tunnelId, configId: managed.configId });
        const urls = await managed.instance.start();
        logger.info("Tunnel started", { tunnelId, urls });

        // Apply any additional forwarding after the tunnel has started
        if (Array.isArray(managed.additionalForwarding) && managed.additionalForwarding.length > 0) {
            logger.debug("Applying additional forwarding rules", managed.additionalForwarding);
            for (const f of managed.additionalForwarding) {
                try {
                    if (!f || !f.remotePort || !f.localDomain || !f.localPort) continue;
                    const hostname = f.remoteDomain && f.remoteDomain.length > 0
                        ? `${f.remoteDomain}:${f.remotePort}`
                        : `${f.remotePort}`;
                    const target = `${f.localDomain}:${f.localPort}`;
                    managed.instance.tunnelRequestAdditionalForwarding(hostname, target);
                    logger.info("Applied additional forwarding", { tunnelId, hostname, target });
                } catch (e) {
                    logger.warn(`Failed to apply additional forwarding (${JSON.stringify(f)}):`, e);
                }
            }
        }

        return urls;
    }

    /**
     * Stop a tunnel by tunnelId
     */
    stopTunnel(tunnelId: string): void {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);

        logger.info("Stopping tunnel", { tunnelId, configId: managed.configId });
        managed.instance.stop();
        this.tunnelsByTunnelId.delete(tunnelId);
        this.tunnelsByConfigId.delete(managed.configId);
        logger.info("Tunnel stopped", { tunnelId });
    }

    /**
     * Get all public URLs for a tunnel
     */
    getTunnelUrls(tunnelId: string): string[] {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        const urls = managed.instance.urls();
        logger.debug("Queried tunnel URLs", { tunnelId, urls });
        return urls;
    }

    /**
     * Get status of a tunnel
     */
    getTunnelStatus(tunnelId: string): string {
        const managed = this.tunnelsByTunnelId.get(tunnelId);
        if (!managed) throw new Error(`Tunnel "${tunnelId}" not found`);
        const status = managed.instance.getStatus();
        logger.debug("Queried tunnel status", { tunnelId, status });
        return status;
    }

    /**
     * Stop all tunnels
     */
    stopAllTunnels(): void {
        for (const { instance } of this.tunnelsByTunnelId.values()) {
            try {
                instance.stop();
            } catch (e) {
                logger.warn("Error stopping tunnel instance", e);
            }
        }
        this.tunnelsByTunnelId.clear();
        this.tunnelsByConfigId.clear();
        logger.info("All tunnels stopped and cleared");
    }

    getTunnelInstance(configId?: string, tunnelId?: string): TunnelInstance {
        if (configId) {
            const managed = this.tunnelsByConfigId.get(configId);
            if (!managed) throw new Error(`Tunnel "${configId}" not found`);
            return managed.instance;
        }
        if (tunnelId) {
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
