import blessed from "blessed";

export interface ModalManager {
    detailModal: blessed.Widgets.BoxElement | null;
    keyBindingsModal: blessed.Widgets.BoxElement | null;
    inDetailView: boolean;
    keyBindingView: boolean;
}

/**
 * Shows the detail modal with request/response data
 */
export function showDetailModal(
    screen: blessed.Widgets.Screen,
    manager: ModalManager,
    requestText?: string,
    responseText?: string
): void {
    manager.inDetailView = true;

    manager.detailModal = blessed.box({
        parent: screen,
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

    manager.detailModal.setContent(content);
    manager.detailModal.focus();
    screen.render();
}

/**
 * Closes the detail modal
 */
export function closeDetailModal(
    screen: blessed.Widgets.Screen,
    manager: ModalManager
): void {
    if (manager.detailModal) {
        manager.detailModal.destroy();
        manager.detailModal = null;
    }
    manager.inDetailView = false;
    screen.render();
}

/**
 * Shows the key bindings modal
 */
export function showKeyBindingsModal(
    screen: blessed.Widgets.Screen,
    manager: ModalManager
): void {
    manager.keyBindingView = true;

    manager.keyBindingsModal = blessed.box({
        parent: screen,
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
Ctrl+c          Force Exit

{white-bg}{black-fg}Press ESC to close{/black-fg}{/white-bg}`;

    manager.keyBindingsModal.setContent(content);
    manager.keyBindingsModal.focus();
    screen.render();
}

/**
 * Closes the key bindings modal
 */
export function closeKeyBindingsModal(
    screen: blessed.Widgets.Screen,
    manager: ModalManager
): void {
    if (manager.keyBindingsModal) {
        manager.keyBindingsModal.destroy();
        manager.keyBindingsModal = null;
    }
    manager.keyBindingView = false;
    screen.render();
}
