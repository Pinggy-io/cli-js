import QRCode from "qrcode";

/**
 * Generate QR codes for a list of URLs
 */
export async function createQrCodes(urls: string[]): Promise<string[]> {
    const codes: string[] = [];
    
     for (const url of urls) {
        const qr = await QRCode.toString(url, {
            type: "terminal",
            small: true,                  
            margin: 0,                    
            errorCorrectionLevel: "L",    

        });
        codes.push(qr);
    }
    return codes;
}
