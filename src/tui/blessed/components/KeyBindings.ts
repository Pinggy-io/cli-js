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
    pairs: ReqResPair[];
    urls: string[];
}

export interface KeyBindingsCallbacks {
    onQrIndexChange: (index: number) => void;
    onSelectedIndexChange: (index: number, requestKey: number | null) => void;
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
): void {
    let inactivityTimeout: NodeJS.Timeout | null = null;
    const { inactivityHttpSelectorTimeoutMs } = getTuiConfig();
    const INACTIVITY_TIMEOUT_MS = inactivityHttpSelectorTimeoutMs;

    // Function to reset inactivity timer
    const resetInactivityTimer = () => {
        if (inactivityTimeout) {
            clearTimeout(inactivityTimeout);
        }
        // Only start timer if there's a selection
        if (state.selectedIndex !== -1) {
            inactivityTimeout = setTimeout(() => {
                // Clear selection and reset viewport to top
                callbacks.onSelectedIndexChange(-1, null);
                callbacks.updateRequestsDisplay();
            }, INACTIVITY_TIMEOUT_MS);
        }
    };

    // Exit on Ctrl+C
    screen.key(["C-c"], () => {
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
        // Clear selection and reset viewport to top
        if (state.selectedIndex !== -1) {
            if (inactivityTimeout) {
                clearTimeout(inactivityTimeout);
                inactivityTimeout = null;
            }
            callbacks.onSelectedIndexChange(-1, null);
            callbacks.updateRequestsDisplay();
        }
    });

    // Navigation - Up
    screen.key(["up"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        resetInactivityTimer();
        if (state.selectedIndex === -1) {
            // No selection: select first item (latest request)
            const requestKey = state.pairs[0]?.request?.key ?? null;
            callbacks.onSelectedIndexChange(0, requestKey);
            callbacks.updateRequestsDisplay();
            resetInactivityTimer(); // Start timer after selection
        } else if (state.selectedIndex > 0) {
            const newIndex = state.selectedIndex - 1;
            const requestKey = state.pairs[newIndex]?.request?.key ?? null;
            callbacks.onSelectedIndexChange(newIndex, requestKey);
            callbacks.updateRequestsDisplay();
        }
    });

    // Navigation - Down
    screen.key(["down"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        resetInactivityTimer();
        const config = getTuiConfig();
        // Limit to maxRequestPairs for navigation bounds
        const limitedLength = Math.min(state.pairs.length, config.maxRequestPairs);
        if (state.selectedIndex === -1) {
            // No selection: select first item (latest request)
            if (limitedLength > 0) {
                const requestKey = state.pairs[0]?.request?.key ?? null;
                callbacks.onSelectedIndexChange(0, requestKey);
                callbacks.updateRequestsDisplay();
                resetInactivityTimer(); // Start timer after selection
            }
        } else if (state.selectedIndex < limitedLength - 1) {
            const newIndex = state.selectedIndex + 1;
            const requestKey = state.pairs[newIndex]?.request?.key ?? null;
            callbacks.onSelectedIndexChange(newIndex, requestKey);
            callbacks.updateRequestsDisplay();
        }
    });

    // End - Jump to last item
    screen.key(["end"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        resetInactivityTimer();
        const config = getTuiConfig();
        const limitedLength = Math.min(state.pairs.length, config.maxRequestPairs);
        const lastIndex = Math.max(0, limitedLength - 1);
        if (state.selectedIndex !== lastIndex) {
            const requestKey = state.pairs[lastIndex]?.request?.key ?? null;
            callbacks.onSelectedIndexChange(lastIndex, requestKey);
            callbacks.updateRequestsDisplay();
        }
    });

    // Enter to view details
    screen.key(["enter"], async () => {
        if (modalManager.inDetailView || modalManager.keyBindingView || modalManager.loadingView) return;
        // Only work when there's a selection
        if (state.selectedIndex === -1) return;

        resetInactivityTimer();
        const pair = state.pairs[state.selectedIndex];
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
