import React from "react";
import { Box, Text } from "ink";
import Gradient from "ink-gradient";
import { asciiArtPinggyLogo } from "../asciArt.js";

export const Container = ({ children }: { children: React.ReactNode }) => (
	<Box flexDirection="column" height="100%" width="100%" padding={1}>
		<Gradient name="fruit">
			<Text>{asciiArtPinggyLogo}</Text>
		</Gradient>
		<Text>Secure tunnels to localhost with live stats.</Text>
		<Box marginTop={1} flexGrow={1} width="100%">
			{children}
		</Box>
	</Box>
);
