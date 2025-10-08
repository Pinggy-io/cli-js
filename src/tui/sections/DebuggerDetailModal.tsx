import React from "react";
import { Box, Text } from "ink";

interface DebuggerDetailModalProps {
	requestText?: string;
	responseText?: string;
	onClose: () => void;
}

export const DebuggerDetailModal = ({
	requestText,
	responseText,
	onClose,
}: DebuggerDetailModalProps) => {
	return (
		<Box
			flexDirection="column"
			width="100%"
			height="100%"
			position="absolute"
			alignItems="center"
			justifyContent="center"
		>
			<Box
				flexDirection="column"
				paddingX={2}
				paddingY={1}
				width="90%"
				height="90%"
				overflow="hidden"
				backgroundColor="default"
				borderStyle="round"
				borderColor="green"
			>
				<Text color="cyanBright" bold>
					Request
				</Text>
				<Text wrap="truncate-end">{requestText || "(no request data)"}</Text>

				<Box marginTop={1} />

				<Text color="magentaBright" bold>
					Response
				</Text>
				<Text wrap="truncate-end">{responseText || "(no response data)"}</Text>

				<Box marginTop={1} justifyContent="center">
					<Text dimColor>Press ESC to close</Text>
				</Box>
			</Box>
		</Box>
	);
};
