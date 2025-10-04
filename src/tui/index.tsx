import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Gradient from "ink-gradient";
import { TunnelUsageType } from "@pinggy/pinggy";
import { useTerminalSize } from "./useTerminalSize.js";
import { asciiArtPinggyLogo } from "./asciArt.js";

const Borders = ({ children }: { children: React.ReactNode }) => (
	<Box borderStyle="round" borderColor="green" padding={1} flexDirection="column" width="100%" alignItems="center">
		{children}
	</Box>
);

function Container({ children }: { children: React.ReactNode }) {
	return (
		<Box flexDirection="column"
			height="100%"
			width="100%"
			padding={1}>
			<Gradient name="fruit">
				<Text>{asciiArtPinggyLogo}</Text>
			</Gradient>
			<Text>Secure tunnels to localhost with live stats.</Text>
			<Box marginTop={1} flexGrow={1} width={"100%"}>{children}</Box>
		</Box>
	);
}

interface TunnelAppProps {
	urls: string[];
	greet?: string;
	tunnel: any;
	manager: any;
	listenerId?: string;
}

const TunnelTui = ({ urls, greet }: TunnelAppProps) => {
	const { columns: terminalWidth } = useTerminalSize();
	console.log("Terminal width:", terminalWidth);
	const [stats, setStats] = useState<TunnelUsageType>({
		elapsedTime: 0,
		numLiveConnections: 0,
		numTotalConnections: 0,
		numTotalReqBytes: 0,
		numTotalResBytes: 0,
		numTotalTxBytes: 0,
	});

	// Receive live stats from TunnelManager via global callback
	useEffect(() => {
		globalThis.__PINGGY_TUNNEL_STATS__ = (newStats: TunnelUsageType) => {
			setStats({ ...newStats });
		};
		return () => {
			delete globalThis.__PINGGY_TUNNEL_STATS__;
		};
	}, []);

	return (
		<Container>
			<Borders>
				{greet && (
					<Box justifyContent="center" width="100%">
						<Text color="cyanBright" bold>
							{greet}
						</Text>
					</Box>
				)}

				<Box
					display="flex"
					flexDirection="row"
					marginTop={1}
					width="100%"
					gap={4}
					justifyContent="space-between">
					{/* LEFT: URLs */}
					<Box
						flexDirection="column"
						flexGrow={1}
						paddingX={1}
						alignItems="flex-start"
					>
						<Text color="greenBright" bold>
							Public URLs
						</Text>
						{urls.map((url) => (
							<Text key={url} color="magentaBright">
								{"• " + url}
							</Text>
						))}
					</Box>

					{/* RIGHT SIDE: Stats */}
					<Box
						flexDirection="column"
						flexGrow={1}
						paddingX={1}
						alignItems="flex-start"
					>
						<Text color="greenBright" bold>
							Live Stats
						</Text>
						<Text>Elapsed: {stats.elapsedTime}s</Text>
						<Text>Live Connections: {stats.numLiveConnections}</Text>
						<Text>Total Connections: {stats.numTotalConnections}</Text>
						<Text>Request Bytes: {stats.numTotalReqBytes}</Text>
						<Text>Response Bytes: {stats.numTotalResBytes}</Text>
						<Text>Total Transfer: {stats.numTotalTxBytes}</Text>
					</Box>
				</Box>
				{/* Footer */}
				<Box marginTop={1} justifyContent="center">
					<Text dimColor>Press Ctrl+C to stop the tunnel.</Text>
				</Box>
			</Borders>
		</Container>
	);
};

export default TunnelTui;
