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
    key: number
): Promise<HeadersResult> {
    if (!baseUrl) {
        return { req: "", res: "" };
    }

    try {
        const [reqRes, resRes] = await Promise.all([
            fetch(`http://${baseUrl}/introspec/getrawrequestheader`, {
                headers: { "X-Introspec-Key": key.toString() },
            }),
            fetch(`http://${baseUrl}/introspec/getrawresponseheader`, {
                headers: { "X-Introspec-Key": key.toString() },
            }),
        ]);

        const [req, res] = await Promise.all([reqRes.text(), resRes.text()]);
        return { req, res };
    } catch (err: any) {
        logger.error("Error fetching headers:", err.message || err);
        return { req: "", res: "" };
    }
}
