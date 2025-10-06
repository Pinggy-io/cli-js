import { useEffect, useState } from "react";
import { TunnelUsageType } from "@pinggy/pinggy";

export function useTunnelStats() {
	const [stats, setStats] = useState<TunnelUsageType>({
		elapsedTime: 0,
		numLiveConnections: 0,
		numTotalConnections: 0,
		numTotalReqBytes: 0,
		numTotalResBytes: 0,
		numTotalTxBytes: 0,
	});

	useEffect(() => {
		globalThis.__PINGGY_TUNNEL_STATS__ = (newStats: TunnelUsageType) => {
			setStats({ ...newStats });
		};
		return () => {
			delete globalThis.__PINGGY_TUNNEL_STATS__;
		};
	}, []);

	return stats;
}
