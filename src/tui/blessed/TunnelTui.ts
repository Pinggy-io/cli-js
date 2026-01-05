import blessed from "blessed";
import { FinalConfig, ReqResPair } from "../../types.js";
import { TunnelUsageType } from "@pinggy/pinggy";
import { asciiArtPinggyLogo } from "../ink/asciArt.js";
import { getBytesInt, getStatusColor } from "../ink/utils/utils.js";
import { createQrCodes } from "./qrCodeGenerator.js";
import { createWebDebuggerConnection, WebDebuggerConnection } from "./webDebuggerConnection.js";
import { fetchReqResHeaders } from "./headerFetcher.js";
import { logger } from "../../logger.js";
import { ManagedTunnel, TunnelManager } from "../../tunnel_manager/TunnelManager.js";

const MIN_WIDTH_WARNING = 60;
const SIMPLE_LAYOUT_THRESHOLD = 80;

interface TunnelAppProps {
    urls: string[];
    greet?: string;
    tunnelConfig?: FinalConfig;
    disconnectInfo?: {
        disconnected: boolean;
        error?: string;
        messages?: string[];
    } | null;
    tunnelInstance?:ManagedTunnel
}

export class TunnelTui {
    private screen: blessed.Widgets.Screen;
    private urls: string[];
    private greet: string;
    private tunnelConfig: FinalConfig | undefined;
    private disconnectInfo: TunnelAppProps["disconnectInfo"];

    // State
    private currentQrIndex: number = 0;
    private selectedIndex: number = 0;
    private inDetailView: boolean = false;
    private keyBindingView: boolean = false;
    private qrCodes: string[] = [];
    private stats: TunnelUsageType = {
        elapsedTime: 0,
        numLiveConnections: 0,
        numTotalConnections: 0,
        numTotalReqBytes: 0,
        numTotalResBytes: 0,
        numTotalTxBytes: 0,
    };
    private pairs: Map<number, ReqResPair> = new Map();
    private webDebuggerConnection: WebDebuggerConnection | null = null;

    // UI Elements
    private mainContainer!: blessed.Widgets.BoxElement;
    private logoBox!: blessed.Widgets.BoxElement;
    private contentBox!: blessed.Widgets.BoxElement;
    private urlsBox!: blessed.Widgets.BoxElement;
    private statsBox!: blessed.Widgets.BoxElement;
    private requestsBox!: blessed.Widgets.BoxElement;
    private qrCodeBox!: blessed.Widgets.BoxElement;
    private footerBox!: blessed.Widgets.BoxElement;
    private detailModal!: blessed.Widgets.BoxElement | null;
    private keyBindingsModal!: blessed.Widgets.BoxElement | null;
    private warningBox!: blessed.Widgets.BoxElement | null;
    private tunnelInstance?:ManagedTunnel

    private exitPromiseResolve: (() => void) | null = null;
    private exitPromise: Promise<void>;

    constructor(props: TunnelAppProps) {
        this.urls = props.urls;
        this.greet = props.greet || "";
        this.tunnelConfig = props.tunnelConfig;
        this.disconnectInfo = props.disconnectInfo;
        if(props.tunnelInstance){
            this.tunnelInstance=props.tunnelInstance
        }

        this.exitPromise = new Promise((resolve) => {
            this.exitPromiseResolve = resolve;
        });

        this.screen = blessed.screen({
            smartCSR: true,
            title: "Pinggy Tunnel",
            fullUnicode: true,
        });

        this.setupStatsListener();
        this.setupWebDebugger();
        this.generateQrCodes();
        this.createUI();
        this.setupKeyBindings();
    }

    private setupStatsListener() {
        globalThis.__PINGGY_TUNNEL_STATS__ = (newStats: TunnelUsageType) => {
            this.stats = { ...newStats };
            this.updateStatsDisplay();
        };
    }

    private setupWebDebugger() {
        if (this.tunnelConfig?.webDebugger) {
            this.webDebuggerConnection = createWebDebuggerConnection(
                this.tunnelConfig.webDebugger,
                (pairs) => {
                    this.pairs = pairs;
                    this.updateRequestsDisplay();
                }
            );
        }
    }

    private async generateQrCodes() {
        if (this.tunnelConfig?.qrCode && this.urls.length > 0) {
            this.qrCodes = await createQrCodes(this.urls);
            this.updateQrCodeDisplay();
        }
    }

    private createUI() {
        const width = this.screen.width as number;

        if (width < MIN_WIDTH_WARNING) {
            this.createWarningUI();
            return;
        }

        if (width < SIMPLE_LAYOUT_THRESHOLD) {
            this.createSimpleUI();
        } else {
            this.createFullUI();
        }

        this.screen.on("resize", () => {
            this.handleResize();
        });
    }

    private createWarningUI() {
        this.warningBox = blessed.box({
            parent: this.screen,
            top: "center",
            left: "center",
            width: "80%",
            height: 5,
            content: `{red-fg}{bold}Terminal is too narrow to show TUI (${this.screen.width} cols).{/bold}{/red-fg}\n{yellow-fg}Please resize your terminal to at least ${MIN_WIDTH_WARNING} columns for proper display.{/yellow-fg}`,
            tags: true,
            align: "center",
            valign: "middle",
            
        });
        this.screen.render();
    }

    private createFullUI() {
        // Main container
        this.mainContainer = blessed.box({
            parent: this.screen,
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            padding: 1,
        });

        // Logo
        this.logoBox = blessed.box({
            parent: this.mainContainer,
            top: 0,
            left: 0,
            width: "100%",
            height: 7,
            content: this.colorizeGradient(asciiArtPinggyLogo),
            tags: true,
        });

        // Content box with border
        this.contentBox = blessed.box({
            parent: this.mainContainer,
            top: 8,
            left: 0,
            width: "100%",
            height: "100%-10",
            border: {
                type: "line",
            },
            style: {
                border: {
                    fg: "green",
                },
            },
            padding: 1,
        });

        // Greet message
        if (this.greet) {
            const greetBox = blessed.box({
                parent: this.contentBox,
                top: 0,
                left: "center",
                width: "80%",
                height: "shrink",
                content: `{bold}${this.greet}{/bold}`,
                tags: true,
                align: "center",
                style: {
                    fg: 'green',
                },
            });
        }

        // Upper section: URLs + Stats
        const greetHeight = this.greet ? Math.max(Math.ceil(this.greet.length / (this.screen.width as number * 0.8)), 1) + 1 : 0;
        const upperSection = blessed.box({
            parent: this.contentBox,
            top: greetHeight,
            left: 0,
            width: "100%",
            height: 10,
        });

        // URLs section
        this.urlsBox = blessed.box({
            parent: upperSection,
            top: 0,
            left: 0,
            width: "50%",
            height: "100%",
            padding: { left: 1, right: 1 },
           
            tags: true,
        });
        this.updateUrlsDisplay();

        // Stats section
        this.statsBox = blessed.box({
            parent: upperSection,
            top: 0,
            right: 0,
            left: "50%",
            width: "49%",
            height: "100%",
            padding: { left: 1, right: 1 },
            tags: true,
        });
        this.updateStatsDisplay();

        // Lower section: Requests + QR Code
        const lowerSectionTop = greetHeight + 11;
        const lowerSection = blessed.box({
            parent: this.contentBox,
            top: lowerSectionTop,
            left: 0,
            width: "100%",
            height: `100%-${lowerSectionTop + 3}`,
        });

        const isQrCodeRequested = this.tunnelConfig?.qrCode || false;

        // Requests section
        this.requestsBox = blessed.box({
            parent: lowerSection,
            top: 0,
            left: 0,
            width: isQrCodeRequested ? "60%" : "80%",
            height: "100%",
            padding: { left: 1, right: 1 },
            tags: true,
            scrollable: true,
        });
        this.updateRequestsDisplay();

        // QR Code section
        if (isQrCodeRequested) {
            this.qrCodeBox = blessed.box({
                parent: lowerSection,
                top: 0,
                right: 0,
                width: "40%",
                height: "100%",
                padding: { left: 1, right: 1 },
            });
            this.updateQrCodeDisplay();
        }

        // Footer
        this.footerBox = blessed.box({
            parent: this.contentBox,
            bottom: 0,
            left: "center",
            width: "shrink",
            height: 1,
            content: "Press Ctrl+C to stop the tunnel. Or press h for key bindings.",
            tags: true,
            style: {
                fg: 'white',
            }
        });

        this.screen.render();
    }

    private createSimpleUI() {
        this.mainContainer = blessed.box({
            parent: this.screen,
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            padding: { left: 1, right: 1 },
        });

        let currentTop = 0;

        // Greet message
        if (this.greet) {
            const greetBox = blessed.box({
                parent: this.mainContainer,
                top: currentTop,
                left: "center",
                width: "90%",
                height: "shrink",
                content: `{bold}${this.greet}{/bold}`,
                tags: true,
                align: "center",
                style: {
                    fg: 'cyan'
                }
            });
            
            // Calculate height based on content to adjust currentTop properly
            const lines = Math.ceil(this.greet.length / (this.screen.width as number * 0.9));
            currentTop += Math.max(lines, 1) + 1;
        }

        // URLs section
        this.urlsBox = blessed.box({
            parent: this.mainContainer,
            top: currentTop,
            left: 0,
            width: "100%",
            height: this.urls.length + 2,
            tags: true,
        });
        this.updateUrlsDisplay();
        currentTop += this.urls.length + 3;

        // Stats section
        this.statsBox = blessed.box({
            parent: this.mainContainer,
            top: currentTop,
            left: 0,
            width: "100%",
            height: 8,
        });
        this.updateStatsDisplay();
        currentTop += 9;

        // Requests section
        this.requestsBox = blessed.box({
            parent: this.mainContainer,
            top: currentTop,
            left: 0,
            width: "100%",
            height: 12,
        });
        this.updateRequestsDisplay();

        // Footer
        this.footerBox = blessed.box({
            parent: this.mainContainer,
            bottom: 0,
            left: "center",
            width: "shrink",
            height: 1,
            content: "Press Ctrl+C to stop the tunnel. Or press h for key bindings.",
            tags: true,
            style: {
                fg: 'white',

            }
        });

        this.screen.render();
    }

    private updateUrlsDisplay() {
        if (!this.urlsBox) return;

        let content = "{green-fg}{bold}Public URLs{/bold}{/green-fg}\n";
        this.urls.forEach((url, index) => {
            const isSelected = index === this.currentQrIndex;
            const prefix = isSelected ? "→ " : "• ";
            const color = isSelected ? "yellow" : "magenta";
            content += `{${color}-fg}${prefix}${url}{/${color}-fg}\n`;
        });

        this.urlsBox.setContent(content);
        this.screen.render();
    }

    private updateStatsDisplay() {
        if (!this.statsBox) return;

        const content = `{green-fg}{bold}Live Stats{/bold}{/green-fg}
Elapsed: ${this.stats.elapsedTime}s
Live Connections: ${this.stats.numLiveConnections}
Total Connections: ${this.stats.numTotalConnections}
Request: ${getBytesInt(this.stats.numTotalReqBytes)}
Response: ${getBytesInt(this.stats.numTotalResBytes)}
Total Transfer: ${getBytesInt(this.stats.numTotalTxBytes)}`;

        this.statsBox.setContent(content);
        this.statsBox.style = { ...this.statsBox.style };
        (this.statsBox as any).parseContent();
        this.screen.render();
    }

    private updateRequestsDisplay() {
        if (!this.requestsBox) return;

        const allPairs = [...this.pairs.values()];
        const visiblePairs = allPairs.slice(-10);
        const startIndex = allPairs.length - visiblePairs.length;

        let content = "{yellow-fg}HTTP Requests:{/yellow-fg}\n";

        visiblePairs.forEach((pair, i) => {
            const globalIndex = startIndex + i;
            const isSelected = this.selectedIndex === globalIndex;
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

        this.requestsBox.setContent(content);
        this.screen.render();
    }

    private updateQrCodeDisplay() {
        if (!this.qrCodeBox || this.qrCodes.length === 0) return;

        let content = `{green-fg}{bold}QR Code ${this.currentQrIndex + 1}/${this.urls.length}{/bold}{/green-fg}\n\n`;
        content += this.qrCodes[this.currentQrIndex] || "";

        if (this.urls.length > 1) {
            content += "\n{yellow-fg}← → to switch QR codes{/yellow-fg}";
        }

        this.qrCodeBox.setContent(content);
        this.qrCodeBox.style = { ...this.qrCodeBox.style };
        (this.qrCodeBox as any).parseContent();
        this.screen.render();
    }

    private setupKeyBindings() {
        // Exit on Ctrl+C
        this.screen.key(["C-c"], () => {
            const manager = TunnelManager.getInstance();
            manager.stopTunnel(this.tunnelInstance?.tunnelid || "");
            this.destroy();
            process.exit(0);
        });

        // Escape key
        this.screen.key(["escape"], () => {
            if (this.inDetailView) {
                this.closeDetailModal();
                return;
            }
            if (this.keyBindingView) {
                this.closeKeyBindingsModal();
                return;
            }
        });

        // Navigation
        this.screen.key(["up"], () => {
            if (this.inDetailView || this.keyBindingView) return;
            const allPairs = [...this.pairs.values()];
            if (this.selectedIndex > 0) {
                this.selectedIndex--;
                this.updateRequestsDisplay();
            }
        });

        this.screen.key(["down"], () => {
            if (this.inDetailView || this.keyBindingView) return;
            const allPairs = [...this.pairs.values()];
            if (this.selectedIndex < allPairs.length - 1) {
                this.selectedIndex++;
                this.updateRequestsDisplay();
            }
        });

        // Enter to view details
        this.screen.key(["enter"], async () => {
            if (this.inDetailView || this.keyBindingView) return;
            const allPairs = [...this.pairs.values()];
            const pair = allPairs[this.selectedIndex];
            if (pair?.request?.key !== undefined && pair?.request?.key !== null) {
                try {
                    const headers = await fetchReqResHeaders(
                        this.tunnelConfig?.webDebugger || "",
                        pair.request.key
                    );
                    this.showDetailModal(headers.req, headers.res);
                } catch (err) {
                    logger.error("Fetch error:", err);
                }
            }
        });

        // Help toggle
        this.screen.key(["h"], () => {
            if (this.inDetailView) return;
            if (this.keyBindingView) {
                this.closeKeyBindingsModal();
            } else {
                this.showKeyBindingsModal();
            }
        });

        // Copy URL
        this.screen.key(["c"], async () => {
            if (this.inDetailView || this.keyBindingView) return;
            if (this.urls.length > 0) {
                try {
                    const clipboardy = await import("clipboardy");
                    clipboardy.default.writeSync(this.urls[this.currentQrIndex]);
                    // Brief visual feedback could be added here
                } catch (err) {
                    logger.error("Failed to copy to clipboard:", err);
                }
            }
        });

        // QR code navigation
        this.screen.key(["left"], () => {
            if (this.inDetailView || this.keyBindingView) return;
            if (this.currentQrIndex > 0) {
                this.currentQrIndex--;
                this.updateUrlsDisplay();
                this.updateQrCodeDisplay();
            }
        });

        this.screen.key(["right"], () => {
            if (this.inDetailView || this.keyBindingView) return;
            if (this.currentQrIndex < this.urls.length - 1) {
                this.currentQrIndex++;
                this.updateUrlsDisplay();
                this.updateQrCodeDisplay();
            }
        });
    }

    private showDetailModal(requestText?: string, responseText?: string) {
        this.inDetailView = true;

        this.detailModal = blessed.box({
            parent: this.screen,
            top: "center",
            left: "center",
            width: "90%",
            height: "90%",
            border: {
                type: "line",
            },
            style: {
                border: {
                    fg: "green",
                },
            },
            padding: { left: 2, right: 2, top: 1, bottom: 1 },
            tags: true,
            scrollable: true,
            keys: true,
            vi: true,
            alwaysScroll: true,
            scrollbar: {
                ch: " ",
                track: {
                    bg: "cyan",
                },
                style: {
                    inverse: true,
                },
            },
        });

        const content = `{cyan-fg}{bold}Request{/bold}{/cyan-fg}
${requestText || "(no request data)"}

{magenta-fg}{bold}Response{/bold}{/magenta-fg}
${responseText || "(no response data)"}

{white-bg}{black-fg}Press ESC to close{/black-fg}{/white-bg}`;

        this.detailModal.setContent(content);
        this.detailModal.focus();
        this.screen.render();
    }

    private closeDetailModal() {
        if (this.detailModal) {
            this.detailModal.destroy();
            this.detailModal = null;
        }
        this.inDetailView = false;
        this.screen.render();
    }

    private showKeyBindingsModal() {
        this.keyBindingView = true;

        this.keyBindingsModal = blessed.box({
            parent: this.screen,
            top: "center",
            left: "center",
            width: "60%",
            height: "80%",
            border: {
                type: "line",
            },
            style: {
                border: {
                    fg: "green",
                },
            },
            padding: { left: 2, right: 2, top: 1, bottom: 1 },
            tags: true,
        });

        const content = `{cyan-fg}{bold}Key Bindings{/bold}{/cyan-fg}

{bold}h{/bold}         This page
{bold}c{/bold}         Copy the selected URL to clipboard
{bold}Ctrl+c{/bold}    Exit

Enter/Return    Open selected request
Esc             Return to main page
UP (↑)          Scroll up the requests
Down (↓)        Scroll down the requests
Left (←)        Show qr code for previous url
Right (→)       Show qr code for next url
Ctrl+c          Force Exithello

{white-bg}{black-fg}Press ESC to close{/black-fg}{/white-bg}`;

        this.keyBindingsModal.setContent(content);
        this.keyBindingsModal.focus();
        this.screen.render();
    }

    private closeKeyBindingsModal() {
        if (this.keyBindingsModal) {
            this.keyBindingsModal.destroy();
            this.keyBindingsModal = null;
        }
        this.keyBindingView = false;
        this.screen.render();
    }

    private handleResize() {
        const width = this.screen.width as number;

        // Destroy current UI and recreate based on new size
        this.screen.children.forEach((child) => child.destroy());

        if (width < MIN_WIDTH_WARNING) {
            this.createWarningUI();
        } else if (width < SIMPLE_LAYOUT_THRESHOLD) {
            this.createSimpleUI();
        } else {
            this.createFullUI();
        }
    }

    private colorizeGradient(text: string): string {
        // Simple gradient simulation using colors
        const colors = ["red", "yellow", "green", "cyan", "blue", "magenta"];
        const lines = text.split("\n");
        return lines
            .map((line, i) => {
                const color = colors[i % colors.length];
                return `{${color}-fg}${line}{/${color}-fg}`;
            })
            .join("\n");
    }

    public updateDisconnectInfo(info: TunnelAppProps["disconnectInfo"]) {
        this.disconnectInfo = info;
        if (info?.disconnected) {
            this.destroy();
        }
    }

    public start() {
        this.screen.render();
    }

    public waitUntilExit(): Promise<void> {
        return this.exitPromise;
    }

    public destroy() {
        // Cleanup
        delete globalThis.__PINGGY_TUNNEL_STATS__;

        if (this.webDebuggerConnection) {
            this.webDebuggerConnection.close();
        }

        this.screen.destroy();

        if (this.exitPromiseResolve) {
            this.exitPromiseResolve();
        }
    }
}

export default TunnelTui;
