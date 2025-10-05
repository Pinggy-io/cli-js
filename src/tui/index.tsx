import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Gradient from "ink-gradient";
import { TunnelUsageType } from "@pinggy/pinggy";
import { useTerminalSize } from "./useTerminalSize.js";
import { asciiArtPinggyLogo } from "./asciArt.js";
import { FinalConfig } from "../types.js";
import qrcode from "qrcode-terminal";

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
	tunnelConfig?: FinalConfig;
}

const TunnelTui = ({ urls, greet, tunnelConfig }: TunnelAppProps) => {
	const { columns: terminalWidth } = useTerminalSize();
	const isQrCodeRequested = tunnelConfig?.qrCode || false;

	const [stats, setStats] = useState<TunnelUsageType>({
		elapsedTime: 0,
		numLiveConnections: 0,
		numTotalConnections: 0,
		numTotalReqBytes: 0,
		numTotalResBytes: 0,
		numTotalTxBytes: 0,
	});

	// QR Code state
	const [currentQrIndex, setCurrentQrIndex] = useState(0);
	const [qrCodes, setQrCodes] = useState<string[]>([]);

	// Generate QR codes for all URLs
	useEffect(() => {
		if (isQrCodeRequested && urls.length > 0) {
			const generateAllQRCodes = async () => {
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

			generateAllQRCodes();
		}
	}, [urls, isQrCodeRequested]);


	// Handle arrow key navigation for QR codes
	useInput((input, key) => {
		if (isQrCodeRequested && qrCodes.length > 1) {
			if (key.rightArrow && currentQrIndex < urls.length - 1) {
				setCurrentQrIndex(prev => prev + 1);
			} else if (key.leftArrow && currentQrIndex > 0) {
				setCurrentQrIndex(prev => prev - 1);
			}
		}
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
					<Box justifyContent="center" width="100%" marginBottom={1}>
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
					gap={2}
					justifyContent="space-between">

					{/* LEFT: URLs */}
					<Box
						flexDirection="column"
						flexGrow={1}
						paddingX={1}
						alignItems="flex-start"
						width="30%"
					>
						<Text color="greenBright" bold>
							Public URLs
						</Text>
						{urls.map((url, index) => (
							<Text
								key={url}
								color={isQrCodeRequested && index === currentQrIndex ? "yellowBright" : "magentaBright"}
								bold={isQrCodeRequested && index === currentQrIndex}
							>
								{isQrCodeRequested && index === currentQrIndex ? "→ " : "• "}{url}
							</Text>
						))}
					</Box>

					{/* MIDDLE: QR Code (if requested) */}
					{isQrCodeRequested && qrCodes.length > 0 && (
						<Box
							flexDirection="column"
							alignItems="center"
							flexGrow={1}
							paddingX={1}
							width="40%"
						>
							<Text color="greenBright" bold>
								QR Code {currentQrIndex + 1}/{urls.length}
							</Text>

							<Box marginY={1} flexDirection="column" alignItems="center">
								<Text>{qrCodes[currentQrIndex]}</Text>
							</Box>

							{urls.length > 1 && (
								<Text color="yellow" >
									← → to switch QR codes
								</Text>
							)}
						</Box>
					)}

					{/* RIGHT: Stats */}
					<Box
						flexDirection="column"
						flexGrow={1}
						paddingX={1}
						alignItems="flex-start"
						width="30%"
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
				<Box marginTop={1} justifyContent="center" flexDirection="column" alignItems="center">
					<Text dimColor>Press Ctrl+C to stop the tunnel.</Text>
				</Box>
			</Borders>
		</Container>
	);
};

export default TunnelTui;
