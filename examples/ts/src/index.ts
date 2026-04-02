import { TunnelType } from "@pinggy/pinggy";
import { enablePackageLogging, TunnelOperations } from "pinggy";

async function main() {
  const tunnelOperations = new TunnelOperations();
  enablePackageLogging({
    level: "debug",
    filePath: "pinggy.log",
    stdout: true,
    source: true,
    silent: false,
    enableSdkLog: true,
  });

  const config = {
    version: "1.0",
    name: "My Tunnel",
    configId: "1",
    hostKeyCheck: false,
    platformValue: "desktopApp",
    isQrCode: false,
    token: "",
    autoReconnect: false,
    reconnectInterval: 5,
    maxReconnectAttempts: 20,
    force: false,
    keepAliveInterval: 0,
    webDebugger: "localhost:4300",
    forwarding: [
      {
        type: TunnelType.Http,
        address: "http://localhost:8000",
      },
    ],
    ipWhitelist: [],
    basicAuth: [],
    bearerTokenAuth: [],
    xForwardedFor: false,
    httpsOnly: false,
    originalRequestUrl: false,
    allowPreflight: false,
    reverseProxy: false,
  };

  const tunnels = await tunnelOperations.handleStartV2(config);

  await new Promise((res) => setTimeout(res, 5000));
  const result = await tunnelOperations.handleListV2();
  console.log(tunnels);
}

main();
