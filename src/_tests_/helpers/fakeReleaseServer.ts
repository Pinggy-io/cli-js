import http from "node:http";
import { AddressInfo } from "node:net";

export interface FakeAsset {
    body: Buffer;
    /** Sends this Content-Length instead of the real one. */
    contentLength?: number;
    /** Sends no Content-Length. */
    omitContentLength?: boolean;
    /** Answers with a redirect to this URL. */
    redirectTo?: string;
    status?: number;
}

export interface FakeReleaseServer {
    /** Set this as PINGGY_UPDATE_RELEASES_URL. */
    releasesUrl: string;
    origin: string;
    requests: string[];
    /** The tag `/latest` redirects to. Null answers 200 with no redirect. */
    latestTag: string | null;
    /** Never answers any request. */
    hang: boolean;
    assets: Map<string, FakeAsset>;
    close(): Promise<void>;
}

function assetKey(tag: string, name: string): string {
    return `${tag}/${name}`;
}

export function setAsset(server: FakeReleaseServer, tag: string, name: string, asset: FakeAsset): void {
    server.assets.set(assetKey(tag, name), asset);
}

function answerAsset(response: http.ServerResponse, asset: FakeAsset | undefined, isHead: boolean): void {
    if (!asset) {
        response.writeHead(404);
        response.end();
        return;
    }
    if (asset.redirectTo) {
        response.writeHead(302, { Location: asset.redirectTo });
        response.end();
        return;
    }
    const headers: Record<string, number> = {};
    if (!asset.omitContentLength) headers["Content-Length"] = asset.contentLength ?? asset.body.length;
    response.writeHead(asset.status ?? 200, headers);
    if (isHead) {
        response.end();
        return;
    }
    if (asset.contentLength !== undefined && asset.contentLength > asset.body.length) {
        // Promises more bytes than it sends, then cuts the connection.
        response.write(asset.body, () => response.socket?.destroy());
        return;
    }
    response.end(asset.body);
}

export async function startFakeReleaseServer(): Promise<FakeReleaseServer> {
    const server: FakeReleaseServer = {
        releasesUrl: "",
        origin: "",
        requests: [],
        latestTag: null,
        hang: false,
        assets: new Map(),
        close: async () => undefined,
    };

    const httpServer = http.createServer((request, response) => {
        const pathname = request.url ?? "";
        server.requests.push(`${request.method} ${pathname}`);
        if (server.hang) return;

        if (pathname === "/releases/latest") {
            if (server.latestTag === null) {
                response.writeHead(200);
            } else {
                response.writeHead(302, { Location: `${server.releasesUrl}/tag/${server.latestTag}` });
            }
            response.end();
            return;
        }

        const match = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(pathname);
        answerAsset(response, match ? server.assets.get(assetKey(match[1], match[2])) : undefined, request.method === "HEAD");
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    server.origin = `http://127.0.0.1:${port}`;
    server.releasesUrl = `${server.origin}/releases`;
    server.close = () => new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
    });
    return server;
}
