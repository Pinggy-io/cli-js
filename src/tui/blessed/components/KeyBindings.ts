import blessed from "blessed";
import { ReqResPair, FinalConfig } from "../../../types.js";
import { ManagedTunnel, TunnelManager } from "../../../tunnel_manager/TunnelManager.js";
import { fetchReqResHeaders } from "../headerFetcher.js";
import { logger } from "../../../logger.js";
import { ModalManager, showDetailModal, closeDetailModal, showKeyBindingsModal, closeKeyBindingsModal, showLoadingModal, closeLoadingModal, showErrorModal } from "./Modals.js";
import { getTuiConfig } from "../config.js";

export interface KeyBindingsState {
    currentQrIndex: number;
    selectedIndex: number;
    pairs: Map<number, ReqResPair>;
    urls: string[];
}

export interface KeyBindingsCallbacks {
    onQrIndexChange: (index: number) => void;
    onSelectedIndexChange: (index: number) => void;
    onDestroy: () => void;
    updateUrlsDisplay: () => void;
    updateQrCodeDisplay: () => void;
    updateRequestsDisplay: () => void;
}

/**
 * Sets up all key bindings for the TUI
 */
export function setupKeyBindings(
    screen: blessed.Widgets.Screen,
    modalManager: ModalManager,
    state: KeyBindingsState,
    callbacks: KeyBindingsCallbacks,
    tunnelConfig?: FinalConfig,
    tunnelInstance?: ManagedTunnel
): void {
    // Exit on Ctrl+C
    screen.key(["C-c"], () => {
        const manager = TunnelManager.getInstance();
        manager.stopTunnel(tunnelInstance?.tunnelid || "");
        callbacks.onDestroy();
        process.exit(0);
    });

    // Escape key
    screen.key(["escape"], () => {
        // Close loading modal and cancel fetch request
        if (modalManager.loadingView) {
            if (modalManager.fetchAbortController) {
                modalManager.fetchAbortController.abort();
                modalManager.fetchAbortController = null;
            }
            closeLoadingModal(screen, modalManager);
            return;
        }
        if (modalManager.inDetailView) {
            closeDetailModal(screen, modalManager);
            return;
        }
        if (modalManager.keyBindingView) {
            closeKeyBindingsModal(screen, modalManager);
            return;
        }
    });

    // Navigation - Up
    screen.key(["up"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        if (state.selectedIndex > 0) {
            callbacks.onSelectedIndexChange(state.selectedIndex - 1);
            callbacks.updateRequestsDisplay();
        }
    });

    // Navigation - Down
    screen.key(["down"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        const config = getTuiConfig();
        const allPairs = [...state.pairs.values()];
        // Limit to maxRequestPairs for navigation bounds
        const limitedLength = Math.min(allPairs.length, config.maxRequestPairs);
        if (state.selectedIndex < limitedLength - 1) {
            callbacks.onSelectedIndexChange(state.selectedIndex + 1);
            callbacks.updateRequestsDisplay();
        }
    });

    // Home - Jump to first item
    screen.key(["home"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        if (state.selectedIndex !== 0) {
            callbacks.onSelectedIndexChange(0);
            callbacks.updateRequestsDisplay();
        }
    });

    // End - Jump to last item
    screen.key(["end"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        const config = getTuiConfig();
        const allPairs = [...state.pairs.values()];
        const limitedLength = Math.min(allPairs.length, config.maxRequestPairs);
        const lastIndex = Math.max(0, limitedLength - 1);
        if (state.selectedIndex !== lastIndex) {
            callbacks.onSelectedIndexChange(lastIndex);
            callbacks.updateRequestsDisplay();
        }
    });

    // Enter to view details
    screen.key(["enter"], async () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        const allPairs = [...state.pairs.values()];
        const pair = allPairs[state.selectedIndex];
        if (pair?.request?.key !== undefined && pair?.request?.key !== null) {
            // Create AbortController for this fetch request
            const abortController = new AbortController();
            modalManager.fetchAbortController = abortController;
            
            showLoadingModal(screen, modalManager, "Fetching request details...");
            
            try {
                const headers = await fetchReqResHeaders(
                    tunnelConfig?.webDebugger || "",
                    pair.request.key,
                    abortController.signal
                );
                
                // Check if request was aborted
                if (abortController.signal.aborted) {
                    return;
                }
                
                // Close loading and show details
                closeLoadingModal(screen, modalManager);
                modalManager.fetchAbortController = null;
                showDetailModal(screen, modalManager, headers.req, headers.res);
            } catch (err: any) {
                // Don't show error if request was cancelled by user
                if (err?.name === 'AbortError' || abortController.signal.aborted) {
                    logger.info("Fetch request cancelled by user");
                    return;
                }
                
                // Close loading and show error modal
                closeLoadingModal(screen, modalManager);
                modalManager.fetchAbortController = null;
                
                const errorMessage = err?.message || String(err) || "Unknown error occurred";
                logger.error("Fetch error:", err);
                showErrorModal(screen, modalManager, "Failed to fetch request details", errorMessage);
            }
        }
    });

    // Help toggle
    screen.key(["h"], () => {
        if (modalManager.inDetailView || modalManager.loadingView) return;
        if (modalManager.keyBindingView) {
            closeKeyBindingsModal(screen, modalManager);
        } else {
            showKeyBindingsModal(screen, modalManager);
        }
    });

    // Copy URL
    screen.key(["c"], async () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        if (state.urls.length > 0) {
            try {
                const clipboardy = await import("clipboardy");
                clipboardy.default.writeSync(state.urls[state.currentQrIndex]);
            } catch (err) {
                logger.error("Failed to copy to clipboard:", err);
            }
        }
    });

    // QR code navigation - Left
    screen.key(["left"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        if (state.currentQrIndex > 0) {
            callbacks.onQrIndexChange(state.currentQrIndex - 1);
            callbacks.updateUrlsDisplay();
            callbacks.updateQrCodeDisplay();
        }
    });

    // QR code navigation - Right
    screen.key(["right"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        if (state.currentQrIndex < state.urls.length - 1) {
            callbacks.onQrIndexChange(state.currentQrIndex + 1);
            callbacks.updateUrlsDisplay();
            callbacks.updateQrCodeDisplay();
        }
    });
}
