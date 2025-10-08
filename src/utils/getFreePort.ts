import net from "net";

/**
 * Get a free TCP port.
 * If `providedPort` is available, returns that.
 * Otherwise, returns a randomly assigned free port from the OS.
 */
export function getFreePort(webDebugger: string): Promise<number> {
    return new Promise((resolve, reject) => {
        // Try provided port first
        const tryPort = (portToTry: number) => {
            const server = net.createServer();

            server.unref(); 

            server.on("error", (err) => {
                // If provided port failed, try random port (0)
                if (portToTry !== 0) {
                    tryPort(0);
                } else {
                    reject(err);
                }
            });

            server.listen(portToTry, () => {
                const address: net.AddressInfo = server.address() as net.AddressInfo;
                const port = address ? address.port : 0;
                server.close(() => resolve(port));
            });
        };
        let providedPort = 0;
        if (webDebugger && webDebugger.includes(":")) {
            const portPart = webDebugger.split(":")[1];
            const parsed = parseInt(portPart, 10);
            if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
                providedPort = parsed;
            }
        }
        tryPort(providedPort);
    });
}
