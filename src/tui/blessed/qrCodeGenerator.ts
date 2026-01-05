import qrcode from "qrcode-terminal";

/**
 * Generate QR codes for a list of URLs
 */
export async function createQrCodes(urls: string[]): Promise<string[]> {
    const codes: string[] = [];
    
    for (const url of urls) {
        await new Promise<void>((resolve) => {
            qrcode.generate(url, { small: true }, (qr) => {
                codes.push(qr);
                resolve();
            });
        });
    }
    
    return codes;
}
