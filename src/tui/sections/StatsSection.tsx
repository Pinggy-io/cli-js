import React from "react";
import { Box, Text } from "ink";
import { TunnelUsageType } from "@pinggy/pinggy";
import { getBytesInt } from "../utils/utils.js";

export const StatsSection = ({ stats }: { stats: TunnelUsageType }) => (
	<Box flexDirection="column" paddingX={1} alignItems="center" width="40%">
		<Box flexDirection="column" alignItems="flex-start">
			<Text color="greenBright" bold>
				Live Stats
			</Text>
			<Text>Elapsed: {stats.elapsedTime}s</Text>
			<Text>Live Connections: {stats.numLiveConnections}</Text>
			<Text>Total Connections: {stats.numTotalConnections}</Text>
			<Text>Request : {getBytesInt(stats.numTotalReqBytes)}</Text>
			<Text>Response : {getBytesInt(stats.numTotalResBytes)}</Text>
			<Text>Total Transfer: {getBytesInt(stats.numTotalTxBytes)}</Text>
		</Box>
	</Box>
);
