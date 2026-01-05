import React from "react";
import { Box, Text } from "ink";

interface Props {
	qrCodes: string[];
	urls: string[];
	currentQrIndex: number;
}

export const QrCodeSection = ({ qrCodes, urls, currentQrIndex }: Props) => {
	if (qrCodes.length === 0) return null;

	return (
		<Box flexDirection="column" alignItems="center" flexGrow={1} paddingX={1} width="40%" >
			<Text color="greenBright" bold>
				QR Code {currentQrIndex + 1}/{urls.length}
			</Text>

			<Box marginY={1} flexDirection="column" alignItems="center">
				<Text>{qrCodes[currentQrIndex]}</Text>
			</Box>

			{urls.length > 1 && (
				<Text color="yellow">← → to switch QR codes</Text>
			)}
		</Box>
	);
};
