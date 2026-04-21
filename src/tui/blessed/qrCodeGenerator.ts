import QRCode from "qrcode";

/**
 * Generate QR codes for a list of URLs
 */
export async function createQrCodes(urls: string[]): Promise<string[]> {
    const codes: string[] = [];

    for (const url of urls) {
        const raw = await QRCode.toString(url, {
            type: "utf8",
            margin: 2,
            errorCorrectionLevel: "L",
        });
        codes.push(raw);
    }
    return codes;
}