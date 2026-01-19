import blessed from "blessed";
import { TunnelUsageType } from "@pinggy/pinggy";
import { ReqResPair } from "../../../types.js";
import { getBytesInt, getStatusColor } from "../../ink/utils/utils.js";
import { getTuiConfig } from "../config.js";

/**
 * Updates the URLs display box
 */
export function updateUrlsDisplay(
    urlsBox: blessed.Widgets.BoxElement | undefined,
    screen: blessed.Widgets.Screen,
    urls: string[],
    currentQrIndex: number
): void {
    if (!urlsBox) return;

    let content = "{green-fg}{bold}Public URLs{/bold}{/green-fg}\n";
    urls.forEach((url, index) => {
        const isSelected = index === currentQrIndex;
        const prefix = isSelected ? "→ " : "• ";
        const color = isSelected ? "yellow" : "magenta";

        if (isSelected) {
            content += `{bold}{${color}-fg}${prefix}${url}{/${color}-fg}{/bold}\n`;
        } else {
            content += `{${color}-fg}${prefix}${url}{/${color}-fg}\n`;
        }
    });

    urlsBox.setContent(content);
    screen.render();
}

/**
 * Updates the stats display box
 */
export function updateStatsDisplay(
    statsBox: blessed.Widgets.BoxElement | undefined,
    screen: blessed.Widgets.Screen,
    stats: TunnelUsageType
): void {
    if (!statsBox) return;

    const content = `{green-fg}{bold}Live Stats{/bold}{/green-fg}
Elapsed: ${stats.elapsedTime}s
Live Connections: ${stats.numLiveConnections}
Total Connections: ${stats.numTotalConnections}
Request: ${getBytesInt(stats.numTotalReqBytes)}
Response: ${getBytesInt(stats.numTotalResBytes)}
Total Transfer: ${getBytesInt(stats.numTotalTxBytes)}`;

    statsBox.setContent(content);
    statsBox.style = { ...statsBox.style };
    (statsBox as any).parseContent();
    screen.render();
}

/**
 * Updates the requests display box
 * This function displays HTTP requests:
 * - Limits the total pairs to maxRequestPairs (configurable)
 * - Ensures the selected item is always visible in the viewport
 * - Auto-scrolls to keep selector in view when new requests arrive
 */
export function updateRequestsDisplay(
    requestsBox: blessed.Widgets.BoxElement | undefined,
    screen: blessed.Widgets.Screen,
    pairs: Map<number, ReqResPair>,
    selectedIndex: number
): { adjustedSelectedIndex: number; trimmedPairs: Map<number, ReqResPair> } {
    const config = getTuiConfig();
    const { maxRequestPairs, visibleRequestCount, viewportScrollMargin } = config;
    
    if (!requestsBox) {
        return { adjustedSelectedIndex: selectedIndex, trimmedPairs: pairs };
    }

    // Convert to array and limit to maxRequestPairs (keep latest)
    let allPairs = [...pairs.values()];
    let trimmedPairs = pairs;
    
    if (allPairs.length > maxRequestPairs) {
        // Keep only the latest maxRequestPairs
        allPairs = allPairs.slice(-maxRequestPairs);
        
        // Create a new trimmed Map with only the kept pairs
        trimmedPairs = new Map<number, ReqResPair>();
        allPairs.forEach((pair) => {
            if (pair.request?.key !== undefined) {
                trimmedPairs.set(pair.request.key, pair);
            }
        });
    }

    const totalPairs = allPairs.length;
    
    // Adjust selectedIndex if it's now out of bounds due to trimming
    let adjustedSelectedIndex = selectedIndex;
    if (adjustedSelectedIndex >= totalPairs) {
        adjustedSelectedIndex = Math.max(0, totalPairs - 1);
    }

    // Calculate viewport window to ensure selector is always visible
    let viewportStart: number;
    
    if (totalPairs <= visibleRequestCount) {
        // All pairs fit in the viewport
        viewportStart = 0;
    } else { 
        // Default: show latest requests (scroll to bottom)
        viewportStart = Math.max(0, totalPairs - visibleRequestCount);
        
        // If selector would be above the viewport, scroll up to show it
        if (adjustedSelectedIndex < viewportStart + viewportScrollMargin) {
            viewportStart = Math.max(0, adjustedSelectedIndex - viewportScrollMargin);
        }
        
        // If selector would be below the viewport, scroll down to show it
        if (adjustedSelectedIndex >= viewportStart + visibleRequestCount - viewportScrollMargin) {
            viewportStart = Math.min(
                totalPairs - visibleRequestCount,
                adjustedSelectedIndex - visibleRequestCount + 1 + viewportScrollMargin
            );
        }
    }

    const viewportEnd = Math.min(viewportStart + visibleRequestCount, totalPairs);
    const visiblePairs = allPairs.slice(viewportStart, viewportEnd);

    let content = "{yellow-fg}HTTP Requests:{/yellow-fg}";
    
    // Show scroll indicator if there are items above the viewport
    if (viewportStart > 0) {
        content += ` {gray-fg}↑ ${viewportStart} more{/gray-fg}`;
    }
    content += "\n";

    visiblePairs.forEach((pair, i) => {
        const globalIndex = viewportStart + i;
        const isSelected = adjustedSelectedIndex === globalIndex;
        const prefix = isSelected ? "> " : "  ";
        const method = pair.request?.method || "";
        const uri = pair.request?.uri || "";
        const status = pair.response?.status || "";
        const statusColor = getStatusColor(String(status));

        if (isSelected) {
            content += `{cyan-fg}${prefix}${method} ${status} ${uri}{/cyan-fg}\n`;
        } else if (pair.response) {
            content += `{${statusColor}-fg}${prefix}${method} ${status} ${uri}{/${statusColor}-fg}\n`;
        } else {
            content += `${prefix}${method} ...${uri}\n`;
        }
    });

    // Show scroll indicator if there are items below the viewport
    const itemsBelow = totalPairs - viewportEnd;
    if (itemsBelow > 0) {
        content += `{gray-fg}  ↓ ${itemsBelow} more{/gray-fg}\n`;
    }


    requestsBox.setContent(content);
    screen.render();
    
    return { adjustedSelectedIndex, trimmedPairs };
}

/**
 * Updates the QR code display box
 */
export function updateQrCodeDisplay(
    qrCodeBox: blessed.Widgets.BoxElement | undefined,
    screen: blessed.Widgets.Screen,
    qrCodes: string[],
    urls: string[],
    currentQrIndex: number
): void {
    if (!qrCodeBox || qrCodes.length === 0) return;

    let content = `{green-fg}{bold}QR Code ${currentQrIndex + 1}/${urls.length}{/bold}{/green-fg}\n`;
    if (urls.length > 1) {
        content += "\n{yellow-fg}← → to switch QR codes{/yellow-fg}\n";
    }
    content += qrCodes[currentQrIndex] || "";
    qrCodeBox.setContent(content);
    qrCodeBox.style = { ...qrCodeBox.style };
    (qrCodeBox as any).parseContent();
    screen.render();
}
