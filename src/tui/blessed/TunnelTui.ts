import blessed from "blessed";
import { FinalConfig, ReqResPair } from "../../types.js";
import { TunnelUsageType } from "@pinggy/pinggy";
import { createQrCodes } from "./qrCodeGenerator.js";
import { createWebDebuggerConnection, WebDebuggerConnection } from "./webDebuggerConnection.js";
import { ManagedTunnel, TunnelManager } from "../../tunnel_manager/TunnelManager.js";
import {
    createFullUI,
    createSimpleUI,
    createWarningUI,
    UIElements,
    MIN_WIDTH_WARNING,
    SIMPLE_LAYOUT_THRESHOLD,
} from "./components/UIComponents.js";
import {
    updateUrlsDisplay,
    updateStatsDisplay,
    updateRequestsDisplay,
    updateQrCodeDisplay,
} from "./components/DisplayUpdaters.js";
import {
    ModalManager,
    showDisconnectModal,
    showReconnectingModal,
    closeReconnectingModal,
    showReconnectionFailedModal,
} from "./components/Modals.js";
import {
    setupKeyBindings,
    KeyBindingsState,
    KeyBindingsCallbacks,
} from "./components/KeyBindings.js";

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
    private selectedIndex: number = -1;  // -1 means no selection
    private selectedRequestKey: number | null = null;  // Track selected request by key
    private qrCodes: string[] = [];
    private stats: TunnelUsageType = {
        elapsedTime: 0,
        numLiveConnections: 0,
        numTotalConnections: 0,
        numTotalReqBytes: 0,
        numTotalResBytes: 0,
        numTotalTxBytes: 0,
    };
    private pairs: ReqResPair[] = [];
    private webDebuggerConnection: WebDebuggerConnection | null = null;

    // UI Elements
    private uiElements!: UIElements;
    private modalManager: ModalManager = {
        detailModal: null,
        keyBindingsModal: null,
        disconnectModal: null,
        reconnectModal: null,
        inDetailView: false,
        keyBindingView: false,
        inDisconnectView: false,
        inReconnectView: false,
        loadingBox: null,
        loadingView: false,
        fetchAbortController: null,
    };
    private tunnelInstance?: ManagedTunnel

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

    private clearSelection() {
        this.selectedIndex = -1;
        this.selectedRequestKey = null;
    }

    private setupWebDebugger() {
        if (this.tunnelConfig?.webDebugger) {
            this.webDebuggerConnection = createWebDebuggerConnection(
                this.tunnelConfig.webDebugger,
                (pairs) => {
                    this.pairs = pairs;
                    
                    // If there's a selected request key, find its new index
                    if (this.selectedRequestKey !== null) {
                        const newIndex = pairs.findIndex(
                            (pair) => pair.request?.key === this.selectedRequestKey
                        );
                        
                        if (newIndex !== -1) {
                            // Request still exists, update index
                            this.selectedIndex = newIndex;
                        } else {
                            // Request no longer exists, clear selection
                            this.clearSelection();
                        }
                    }
                    
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

    // Create the UI based on terminal size
    private createUI() {
        this.buildUI();
        
        this.screen.on("resize", () => {
            this.handleResize();
        });
    }

    private buildUI() {
        const width = this.screen.width as number;

        if (width < MIN_WIDTH_WARNING) {
            this.uiElements = {
                mainContainer: createWarningUI(this.screen),
                urlsBox: null as any,
                statsBox: null as any,
                requestsBox: null as any,
                footerBox: null as any,
                warningBox: createWarningUI(this.screen),
            };
            this.screen.render();
            return;
        }

        if (width < SIMPLE_LAYOUT_THRESHOLD) {
            this.uiElements = createSimpleUI(this.screen, this.urls, this.greet);
        } else {
            this.uiElements = createFullUI(this.screen, this.urls, this.greet, this.tunnelConfig);
        }

        this.refreshDisplays();
        this.screen.render();
    }

    private refreshDisplays() {
        this.updateUrlsDisplay();
        this.updateStatsDisplay();
        this.updateRequestsDisplay();
        this.updateQrCodeDisplay();
    }

    private updateUrlsDisplay() {
        updateUrlsDisplay(
            this.uiElements?.urlsBox,
            this.screen,
            this.urls,
            this.currentQrIndex
        );
    }

    private updateStatsDisplay() {
        updateStatsDisplay(
            this.uiElements?.statsBox,
            this.screen,
            this.stats
        );
    }

    private updateRequestsDisplay() {
        const result = updateRequestsDisplay(
            this.uiElements?.requestsBox,
            this.screen,
            this.pairs,
            this.selectedIndex
        );
        
        // Update selectedIndex if it was adjusted due to trimming
        if (result.adjustedSelectedIndex !== this.selectedIndex) {
            if (result.adjustedSelectedIndex === -1) {
                // Selection was cleared due to trimming
                this.clearSelection();
            } else {
                // Update to new index
                this.selectedIndex = result.adjustedSelectedIndex;
            }
        }
        
        // Update pairs if they were trimmed (different reference means trimming occurred)
        if (result.trimmedPairs !== this.pairs) {
            this.pairs = result.trimmedPairs;
        }
    }

    private updateQrCodeDisplay() {
        updateQrCodeDisplay(
            this.uiElements?.qrCodeBox,
            this.screen,
            this.qrCodes,
            this.urls,
            this.currentQrIndex
        );
    }

    private setupKeyBindings() {
        const self = this;
        

        // Create a state object with getters to always get current values
        const state: KeyBindingsState = {
            get currentQrIndex() { return self.currentQrIndex; },
            set currentQrIndex(value: number) { self.currentQrIndex = value; },
            get selectedIndex() { return self.selectedIndex; },
            set selectedIndex(value: number) { self.selectedIndex = value; },
            get pairs() { return self.pairs; },
            get urls() { return self.urls; },
        };

        const callbacks: KeyBindingsCallbacks = {
            onQrIndexChange: (index: number) => {
                self.currentQrIndex = index;
            },
            onSelectedIndexChange: (index: number, requestKey: number | null) => {
                self.selectedIndex = index;
                self.selectedRequestKey = requestKey;
            },
            onDestroy: () => self.destroy(),
            updateUrlsDisplay: () => self.updateUrlsDisplay(),
            updateQrCodeDisplay: () => self.updateQrCodeDisplay(),
            updateRequestsDisplay: () => self.updateRequestsDisplay(),
        };

        setupKeyBindings(
            this.screen,
            this.modalManager,
            state,
            callbacks,
            this.tunnelConfig,
        );
    }

    private handleResize() {
        // Destroy current UI and recreate based on new size
        this.screen.children.forEach((child) => child.destroy());
        this.buildUI();
    }

    public updateDisconnectInfo(info: TunnelAppProps["disconnectInfo"]) {
        this.disconnectInfo = info;
        if (info?.disconnected) {
            const message = info.error 
                ? `Error: ${info.error}\nTunnel will be closed.`
                : info.messages?.join('\n') || 'Disconnect request received. Tunnel will be closed.';
            
            showDisconnectModal(
                this.screen,
                this.modalManager,
                message,
                () => this.destroy()
            );
        }
    }

    public updateReconnectingInfo(retryCnt: number, message?: string) {
        showReconnectingModal(
            this.screen,
            this.modalManager,
            retryCnt,
            message
        );
    }

    public closeReconnectingInfo() {
        closeReconnectingModal(this.screen, this.modalManager);
    }

    public updateReconnectionFailed(retryCnt: number) {
        showReconnectionFailedModal(
            this.screen,
            this.modalManager,
            retryCnt,
            () => this.destroy()
        );
    }

    public start() {
        this.screen.render();
    }

    public waitUntilExit(): Promise<void> {
        return this.exitPromise;
    }

    public destroy() {
        // Stop the tunnel first
        if (this.tunnelInstance?.tunnelid) {
            const manager = TunnelManager.getInstance();
            manager.stopTunnel(this.tunnelInstance.tunnelid);
        }

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
