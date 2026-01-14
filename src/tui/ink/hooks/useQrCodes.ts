import { useEffect, useState } from "react";
import qrcode from "qrcode-terminal";

export function useQrCodes(urls: string[], isQrCodeRequested: boolean) {
	const [qrCodes, setQrCodes] = useState<string[]>([]);

	useEffect(() => {
		if (!isQrCodeRequested || urls.length === 0) return;

		const generateAll = async () => {
			const codes: string[] = [];
			for (const url of urls) {
				await new Promise<void>((resolve) => {
					qrcode.generate(url, { small: true }, (qr) => {
						codes.push(qr);
						resolve();
					});
				});
			}
			setQrCodes(codes);
		};

		generateAll();
	}, [urls, isQrCodeRequested]);

	return qrCodes;
}
