import { TunnelManager } from "./TunnelManager";
import {TUNNEL_CONFIG} from "./TunnelConfig";

async function main() {
    const manager = new TunnelManager();

    // Option 1: Create first, then start
    const tunnel1 = manager.createTunnel(TUNNEL_CONFIG[0]);
    const tunnel2 = manager.createTunnel(TUNNEL_CONFIG[1]);
    console.log(manager.getTunnelConfig(tunnel1.configId,""));
    console.log(manager.getTunnelConfig("", tunnel2.tunnelId));
    console.log("Tunnel 1 ",tunnel1.instance.getStatus());
    tunnel1.instance.start();
    // console.log("Tunnel 1 ",await tunnel1.instance.start());
    // console.log("Tunnel 1 ",tunnel1.instance.urls());
    // console.log("Tunnel 1 ",tunnel1.instance.getStatus());
    // manager.stopTunnel(tunnel1.tunnelId);
    // console.log("Tunnel 1 ",tunnel1.instance.getStatus());

    const message="Hello World";
    // const urls1 = await manager.startTunnel("web3000");
    // console.log("Tunnel web3000 URLs:", urls1);
    //
    // // Option 2: Directly create + start
    // const tunnel2 = await manager.forwardTunnel("api4000", { forwardTo: "localhost:4000" });
    // console.log("Tunnel api4000 URLs:", tunnel2.urls());
    //
    // // Stop one tunnel
    // manager.stopTunnel("web3000");

    // Close everything
}

main().catch(console.error);
