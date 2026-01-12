import blessed from "blessed";
import { ReqResPair, FinalConfig } from "../../../types.js";
import { ManagedTunnel, TunnelManager } from "../../../tunnel_manager/TunnelManager.js";
import { fetchReqResHeaders } from "../headerFetcher.js";
import { logger } from "../../../logger.js";
import { ModalManager, showDetailModal, closeDetailModal, showKeyBindingsModal, closeKeyBindingsModal } from "./Modals.js";

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
        if (modalManager.inDetailView || modalManager.keyBindingView) return;
        if (state.selectedIndex > 0) {
            callbacks.onSelectedIndexChange(state.selectedIndex - 1);
            callbacks.updateRequestsDisplay();
        }
    });

    // Navigation - Down
    screen.key(["down"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView) return;
        const allPairs = [...state.pairs.values()];
        if (state.selectedIndex < allPairs.length - 1) {
            callbacks.onSelectedIndexChange(state.selectedIndex + 1);
            callbacks.updateRequestsDisplay();
        }
    });

    // Enter to view details
    screen.key(["enter"], async () => {
        if (modalManager.inDetailView || modalManager.keyBindingView) return;
        const allPairs = [...state.pairs.values()];
        const pair = allPairs[state.selectedIndex];
        if (pair?.request?.key !== undefined && pair?.request?.key !== null) {
            try {
                const headers = await fetchReqResHeaders(
                    tunnelConfig?.webDebugger || "",
                    pair.request.key
                );
                showDetailModal(screen, modalManager, headers.req, headers.res);
            } catch (err) {
                logger.error("Fetch error:", err);
            }
        }
    });

    // Help toggle
    screen.key(["h"], () => {
        if (modalManager.inDetailView) return;
        if (modalManager.keyBindingView) {
            closeKeyBindingsModal(screen, modalManager);
        } else {
            showKeyBindingsModal(screen, modalManager);
        }
    });

    // Copy URL
    screen.key(["c"], async () => {
        if (modalManager.inDetailView || modalManager.keyBindingView) return;
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
        if (modalManager.inDetailView || modalManager.keyBindingView) return;
        if (state.currentQrIndex > 0) {
            callbacks.onQrIndexChange(state.currentQrIndex - 1);
            callbacks.updateUrlsDisplay();
            callbacks.updateQrCodeDisplay();
        }
    });

    // QR code navigation - Right
    screen.key(["right"], () => {
        if (modalManager.inDetailView || modalManager.keyBindingView) return;
        if (state.currentQrIndex < state.urls.length - 1) {
            callbacks.onQrIndexChange(state.currentQrIndex + 1);
            callbacks.updateUrlsDisplay();
            callbacks.updateQrCodeDisplay();
        }
    });
}
