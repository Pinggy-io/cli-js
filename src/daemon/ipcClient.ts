/**
 * IPC HTTP client for communicating with the Pinggy daemon from the foreground CLI.
 * Simple, no external dependencies — uses Node's built-in http module.
 */
import http from "node:http";

const REQUEST_TIMEOUT_MS = 10000;

export class IPCClient {
    private port: number;

    constructor(port: number) {
        this.port = port;
    }

    async ping(): Promise<{ status: string; pid: number; uptime: number }> {
        return this.get("/ping");
    }

    async listTunnels(): Promise<any[]> {
        return this.get("/tunnels");
    }

    async startTunnel(name: string): Promise<any> {
        return this.post("/tunnels/start", { name });
    }

    async stopTunnel(tunnelid: string): Promise<any> {
        return this.post("/tunnels/stop", { tunnelid });
    }

    async shutdown(): Promise<any> {
        return this.post("/shutdown", {});
    }

    private get<T>(path: string): Promise<T> {
        return this.request("GET", path);
    }

    private post<T>(path: string, body: object): Promise<T> {
        return this.request("POST", path, JSON.stringify(body));
    }

    private request<T>(method: string, path: string, body?: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    hostname: "127.0.0.1",
                    port: this.port,
                    path,
                    method,
                    headers: body
                        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
                        : undefined,
                    timeout: REQUEST_TIMEOUT_MS,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf-8");
                        const statusCode = res.statusCode ?? 0;
                        if (statusCode < 200 || statusCode >= 300) {
                            reject(new Error(`Daemon returned HTTP ${statusCode}: ${text.slice(0, 200)}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(text) as T);
                        } catch {
                            reject(new Error(`Invalid JSON from daemon: ${text.slice(0, 200)}`));
                        }
                    });
                }
            );

            req.on("error", (err) => reject(new Error(`Cannot connect to daemon: ${err.message}`)));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("Daemon request timed out"));
            });

            if (body) req.write(body);
            req.end();
        });
    }
}
