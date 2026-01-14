import React from "react";
import { Box, Text } from "ink";


export const KeyBindings = () => {
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
				width="60%"
				height="80%"
				overflow="hidden"
				backgroundColor="default"
				borderStyle="round"
				borderColor="green"

			>
				<Box justifyContent="center" marginBottom={1} >
					<Text color="cyanBright" bold> Key Bindings </Text>
				</Box>
				<Box flexDirection="column" padding={1} justifyContent="space-evenly" gap={2} >
					{/* Header */}
					<Box flexDirection="column">
						<Text>
							<Text bold>h</Text>         This page
						</Text>
						<Text>
							<Text bold>c</Text>         Copy the selected URL to clipboard
						</Text>
						<Text>
							<Text bold>Ctrl+c</Text>    Exit
						</Text>
					</Box>

					<Box marginTop={1} flexDirection="column">
						<Text>Enter/Return    Open selected request</Text>
						<Text>Esc             Return to main page</Text>
						<Text>UP (↑)          Scroll up the requests</Text>
						<Text>Down (↓)        Scroll down the requests</Text>
						<Text>Left (←)        Show qr code for previous url</Text>
						<Text>Right (→)       Show qr code for next url</Text>
						<Text>Ctrl+c          Force Exit</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	);
};
