import React from "react";
import { Box, Text } from "ink";

interface Props {
	urls: string[];
	isQrCodeRequested: boolean;
	currentQrIndex: number;
}

export const URLsSection = ({ urls, isQrCodeRequested, currentQrIndex }: Props) => (
	<Box flexDirection="column" paddingX={1} alignItems="flex-start" width="60%">
		<Text color="greenBright" bold>
			Public URLs
		</Text>
		{urls.map((url, index) => (
			<Text
				key={url}
				color={isQrCodeRequested && index === currentQrIndex ? "yellowBright" : "magentaBright"}
				bold={isQrCodeRequested && index === currentQrIndex}
			>
				{isQrCodeRequested && index === currentQrIndex ? "→ " : "• "}
				{url}
			</Text>
		))}
	</Box>
);
