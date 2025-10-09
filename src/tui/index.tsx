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
import { getStatusColor } from "./utils/utils.js";
import { KeyBindings } from "./sections/KeyBindings.js";


interface TunnelAppProps {
	urls: string[];
	greet?: string;
	tunnelConfig?: FinalConfig;
}

const MIN_WIDTH_WARNING = 60;
const SIMPLE_LAYOUT_THRESHOLD = 80;

const TunnelTui = ({ urls, greet, tunnelConfig }: TunnelAppProps) => {
	const { columns: terminalWidth } = useTerminalSize();
	const isQrCodeRequested = tunnelConfig?.qrCode || false;

	// States
	const [currentQrIndex, setCurrentQrIndex] = useState(0);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [inDetailView, setInDetailView] = useState(false);
	const [keyBindingView, setKeyBindingView] = useState(false);

	// Hooks
	const qrCodes = useQrCodes(urls, isQrCodeRequested);
	const stats = useTunnelStats();
	const { pairs } = useWebDebugger(tunnelConfig?.webDebugger);
	const { headers, fetchHeaders, clear } = useReqResHeaders(tunnelConfig?.webDebugger);

	const allPairs = [...pairs.values()];

	// Key handling
	useInput((input, key) => {
		if (inDetailView && key.escape) {
			setInDetailView(false);
			clear();
			return;
		}
		if (keyBindingView && key.escape) {
			setKeyBindingView(false);
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
		if (input === 'h') {
			setKeyBindingView(i => !i);
			return;
		}
		if (qrCodes.length > 1 || urls.length > 1) {
			if (key.rightArrow && currentQrIndex < urls.length - 1) setCurrentQrIndex(i => i + 1);
			if (key.leftArrow && currentQrIndex > 0) setCurrentQrIndex(i => i - 1);
		}
	});

	const visiblePairs = allPairs.slice(-10);
	const startIndex = allPairs.length - visiblePairs.length;

	if (terminalWidth < MIN_WIDTH_WARNING) {
		return (
			<Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
				<Text color="redBright" bold>
					Terminal is too narrow to show TUI ({terminalWidth} cols).
				</Text>
				<Text color="yellow">
					Please resize your terminal to at least {MIN_WIDTH_WARNING} columns for proper display.
				</Text>
			</Box>
		);
	}

	// === Simplified layout for narrow terminals ===
	if (terminalWidth < SIMPLE_LAYOUT_THRESHOLD) {
		return (
			<Box flexDirection="column" paddingX={1} height={"100%"}>
				{greet && (
					<Box justifyContent="center" marginBottom={1}>
						<Text color="cyanBright" bold>{greet}</Text>
					</Box>
				)}

				<URLsSection urls={urls} currentQrIndex={currentQrIndex} width="100%" />

				<Box marginTop={1}>
					<StatsSection stats={stats} />
				</Box>

				<Box flexDirection="column" marginTop={1}>
					<Text color="yellowBright">HTTP Requests:</Text>
					{visiblePairs.map((pair, i) => (
						<Text key={i} color={selectedIndex === startIndex + i ? "greenBright" : "white"}>
							{selectedIndex === startIndex + i ? "> " : "  "}
							{pair.request?.method || ""}
							{" "}
							{pair.response ? (
								<Text color="cyan"> {pair.response.status}</Text>
							) : (
								<Text dimColor>...</Text>
							)}
							{" "}{pair.request?.uri || ""}
						</Text>
					))}
				</Box>

				{/* Qr codes are removed for small terminals */}

				<Box marginTop={1} justifyContent="center">
					<Text dimColor>Press Ctrl+C to stop the tunnel.Or h for key bindings</Text>
				</Box>

				{inDetailView && (
					<DebuggerDetailModal
						requestText={headers?.req}
						responseText={headers?.res}
						onClose={() => setInDetailView(false)}
					/>
				)}
			</Box>
		);
	}


	return (
		<>
			<Container>
				<Borders>
					<Box flexDirection="column" height="100%" justifyContent="space-between">
						{/* ===== Top content ===== */}
						<Box flexDirection="column">
							{greet && (
								<Box justifyContent="center" width="94%" marginBottom={1}>
									<Text color="cyanBright" bold>
										{greet}
									</Text>
								</Box>
							)}

							{/* Upper Box (URL + stats) */}
							<Box flexDirection="row" justifyContent="space-evenly" width="100%" paddingY={1}>
								<URLsSection urls={urls} currentQrIndex={currentQrIndex} />
								<StatsSection stats={stats} />
							</Box>

							{/* Lower Box (Requests + QR code) */}
							<Box flexDirection="row" justifyContent="space-evenly" width="100%" paddingY={1}>
								<Box flexDirection="column" marginBottom={1} width={isQrCodeRequested ? "60%" : "80%"}>
									<Text color="yellowBright">HTTP Requests:</Text>
									{visiblePairs.map((pair, i) => (
										<Text key={i}>
											<Text color={selectedIndex === startIndex + i ? "cyanBright" : getStatusColor(pair.response?.status || "")}>

												{selectedIndex === startIndex + i ? "> " : "  "}
												{pair.request?.method || ""}
												{pair.response ? (
													<Text color={selectedIndex === startIndex + i ? "cyanBright" : getStatusColor(pair.response?.status || "")}>{" "}  {pair.response.status}</Text>
												) : (
													<Text dimColor>...</Text>
												)}
												{" "}{pair.request?.uri || ""}
											</Text>
										</Text>
									))}
								</Box>

								{isQrCodeRequested && (
									<QrCodeSection qrCodes={qrCodes} urls={urls} currentQrIndex={currentQrIndex} />
								)}
							</Box>
						</Box>

						{/* ===== Bottom sticky message ===== */}
						<Box justifyContent="center" marginTop={1}>
							<Text dimColor>Press Ctrl+C to stop the tunnel Or press h for key bindings</Text>
						</Box>
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
			{
				keyBindingView && <KeyBindings />
			}
		</>
	);
};

export default TunnelTui;
