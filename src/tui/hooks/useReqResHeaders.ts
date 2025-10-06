import { useState } from "react";
import { logger } from "../../logger.js";

export function useReqResHeaders(baseUrl?: string) {
  const [headers, setHeaders] = useState<{ req: string; res: string } | null>(null);

  async function fetchHeaders(key: number) {
    if (!baseUrl) return;
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
      setHeaders({ req, res });
    } catch (err: any) {
      logger.error("Error fetching headers:", err.message || err);
    }
  }

  return { headers, fetchHeaders, clear: () => setHeaders(null) };
}
