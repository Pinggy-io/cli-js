import blessed from "blessed";
import { TunnelUsageType } from "@pinggy/pinggy";
import { ReqResPair } from "../../../types.js";
import { getBytesInt, getStatusColor } from "../../ink/utils/utils.js";

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
 */
export function updateRequestsDisplay(
    requestsBox: blessed.Widgets.BoxElement | undefined,
    screen: blessed.Widgets.Screen,
    pairs: Map<number, ReqResPair>,
    selectedIndex: number
): void {
    if (!requestsBox) return;

    const allPairs = [...pairs.values()];
    const visiblePairs = allPairs.slice(-10);
    const startIndex = allPairs.length - visiblePairs.length;

    let content = "{yellow-fg}HTTP Requests:{/yellow-fg}\n";

    visiblePairs.forEach((pair, i) => {
        const globalIndex = startIndex + i;
        const isSelected = selectedIndex === globalIndex;
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

    requestsBox.setContent(content);
    screen.render();
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
