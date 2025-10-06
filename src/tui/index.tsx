import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { FinalConfig } from "../types.js";
import { Container } from "./layout/Container.js";
import { Borders } from "./layout/Borders.js";
import { useQrCodes } from "./hooks/useQrCodes.js";
import { useTunnelStats } from "./hooks/useTerminalStats.js";
import { URLsSection } from "./sections/URLsSection.js";
import { QrCodeSection } from "./sections/QrCodeSection.js";
import { StatsSection } from "./sections/StatsSection.js";
import { useWebDebugger } from "./hooks/useWebDebugger.js";
import { DebuggerDetailModal } from "./sections/DebuggerDetailModal.js";
import { useReqResHeaders } from "./hooks/useReqResHeaders.js";
import { logger } from "../logger.js";


interface TunnelAppProps {
	urls: string[];
	greet?: string;
	tunnelConfig?: FinalConfig;
}

const TunnelTui = ({ urls, greet, tunnelConfig }: TunnelAppProps) => {
	const { columns: terminalWidth } = useTerminalSize();
	const isQrCodeRequested = tunnelConfig?.qrCode || false;

	// QR Code state
	const [currentQrIndex, setCurrentQrIndex] = useState(0);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [inDetailView, setInDetailView] = useState(false);
	const qrCodes = useQrCodes(urls, isQrCodeRequested);
	const stats = useTunnelStats();
	const { pairs } = useWebDebugger(tunnelConfig?.webDebugger);
	const allPairs = [...pairs.values()];
	const { headers, fetchHeaders, clear } = useReqResHeaders(tunnelConfig?.webDebugger);
	
	// Handle arrow key navigation for QR codes
	useInput((input, key) => {
		if (inDetailView && key.escape) {
			setInDetailView(false);
			return;
		}

		if (key.upArrow && selectedIndex > 0) setSelectedIndex((i) => i - 1);
		if (key.downArrow && selectedIndex < allPairs.length - 1) setSelectedIndex((i) => i + 1);

		if (key.return) {
			const pair = allPairs[selectedIndex];
			if (pair && pair.request && pair.request.key !== undefined && pair.request.key !== null) {
				(async () => {
					try {
						await fetchHeaders(pair.request.key);
						setInDetailView(true);
					} catch (err) {
						logger.error("Fetch error:", err);
					}
				})();
			}
		}
		if (isQrCodeRequested && qrCodes.length > 1) {
			if (key.rightArrow && currentQrIndex < urls.length - 1) setCurrentQrIndex(i => i + 1);
			if (key.leftArrow && currentQrIndex > 0) setCurrentQrIndex(i => i - 1);
		}
	});

	const visiblePairs = allPairs.slice(-10);
	const startIndex = allPairs.length - visiblePairs.length;


	return (
		<>
			<Container>
				<Borders>
					{greet && (
						<Box justifyContent="center" width="100%" marginBottom={1}>
							<Text color="cyanBright" bold>{greet}</Text>
						</Box>
					)}
					{/* Upper Box (Url + stats) */}
					<Box flexDirection="row" justifyContent="space-evenly" width="100%" paddingY={1}>
						<URLsSection urls={urls} isQrCodeRequested={isQrCodeRequested} currentQrIndex={currentQrIndex} />
						<StatsSection stats={stats} />
					</Box>
					{/* Lower Box (Requests + QR code) */}
					<Box flexDirection="row" justifyContent="space-evenly" width="100%" paddingY={1}>
						<Box flexDirection="column" marginBottom={1} width={isQrCodeRequested ? "60%" : "80%"}>
							<Text color="yellowBright">HTTP Requests:</Text>

							{visiblePairs.map((pair, i) => (
								<Text key={i} color={selectedIndex === startIndex + i ? "greenBright" : "white"}>
									{selectedIndex === startIndex + i ? "> " : "  "}
									{pair.request?.method || ""} 
									{pair.response ? (
										<Text color="cyan">{" "} / {pair.response.status}</Text>
									) : (
										<Text dimColor>...</Text>
									)}
									{" "}{pair.request?.uri || ""}
								</Text>
							))}

						</Box>
						{isQrCodeRequested && <QrCodeSection qrCodes={qrCodes} urls={urls} currentQrIndex={currentQrIndex} />}

					</Box>

					<Box marginTop={1} justifyContent="center">
						<Text dimColor>Press Ctrl+C to stop the tunnel.</Text>
					</Box>
				</Borders>
			</Container>
			{inDetailView && (
				<DebuggerDetailModal
					requestText={headers?.req}
					responseText={headers?.res}
					onClose={() => setInDetailView(false)}
				/>
			)}
		</>
	);
};

export default TunnelTui;
