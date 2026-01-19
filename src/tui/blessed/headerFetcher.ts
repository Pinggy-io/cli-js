import { logger } from "../../logger.js";

export interface HeadersResult {
    req: string;
    res: string;
}

/**
 * Fetch request/response headers from the web debugger
 */
export async function fetchReqResHeaders(
    baseUrl: string,
    key: number,
    signal?: AbortSignal
): Promise<HeadersResult> {
    if (!baseUrl) {
        return { req: "", res: "" };
    }

    try {
        const [reqRes, resRes] = await Promise.all([
            fetch(`http://${baseUrl}/introspec/getrawrequestheader`, {
                headers: { "X-Introspec-Key": key.toString() },
                signal,
            }),
            fetch(`http://${baseUrl}/introspec/getrawresponseheader`, {
                headers: { "X-Introspec-Key": key.toString() },
                signal,
            }),
        ]);

        const [req, res] = await Promise.all([reqRes.text(), resRes.text()]);
        return { req, res };
    } catch (err: any) {
        // Re-throw abort errors so caller can handle cancellation
        if (err?.name === 'AbortError') {
            throw err;
        }
        logger.error("Error fetching headers:", err.message || err);
        throw err;
    }
}
