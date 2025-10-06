import React from "react";
import { Box, Text } from "ink";
import { TunnelUsageType } from "@pinggy/pinggy";

export const StatsSection = ({ stats }: { stats: TunnelUsageType }) => (
	<Box flexDirection="column" paddingX={1} alignItems="center" width="40%">
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
);
