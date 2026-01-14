import blessed from "blessed";
import { FinalConfig } from "../../../types.js";
import { asciiArtPinggyLogo } from "../../ink/asciArt.js";

export const MIN_WIDTH_WARNING = 60;
export const SIMPLE_LAYOUT_THRESHOLD = 80;

export interface UIElements {
    mainContainer: blessed.Widgets.BoxElement;
    logoBox?: blessed.Widgets.BoxElement;
    contentBox?: blessed.Widgets.BoxElement;
    urlsBox: blessed.Widgets.BoxElement;
    statsBox: blessed.Widgets.BoxElement;
    requestsBox?: blessed.Widgets.BoxElement;
    qrCodeBox?: blessed.Widgets.BoxElement;
    footerBox: blessed.Widgets.BoxElement;
    warningBox?: blessed.Widgets.BoxElement;
}

/**
 * Colorizes text with a gradient of colors
 */
export function colorizeGradient(text: string): string {
    const colors = ["red", "yellow", "green", "cyan", "blue", "magenta"];
    const lines = text.split("\n");
    return lines
        .map((line, i) => {
            const color = colors[i % colors.length];
            return `{${color}-fg}${line}{/${color}-fg}`;
        })
        .join("\n");
}

/**
 * Creates the warning UI when terminal is too narrow
 */
export function createWarningUI(screen: blessed.Widgets.Screen): blessed.Widgets.BoxElement {
    return blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: "80%",
        height: 5,
        content: `{red-fg}{bold}Terminal is too narrow to show TUI (${screen.width} cols).{/bold}{/red-fg}\n{yellow-fg}Please resize your terminal to at least ${MIN_WIDTH_WARNING} columns for proper display.{/yellow-fg}`,
        tags: true,
        align: "center",
        valign: "middle",
        style: {
            fg: 'red'
        }
    });
}

/**
 * Creates the full UI layout for wider terminals
 */
export function createFullUI(
    screen: blessed.Widgets.Screen,
    urls: string[],
    greet: string,
    tunnelConfig?: FinalConfig
): UIElements {
    // Main container
    const mainContainer = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        padding: 1,
    });

    // Logo
    const logoBox = blessed.box({
        parent: mainContainer,
        top: 0,
        left: 0,
        width: "100%",
        height: 7,
        content: colorizeGradient(asciiArtPinggyLogo),
        tags: true,
    });

    // Content box with border
    const contentBox = blessed.box({
        parent: mainContainer,
        top: 8,
        left: 0,
        width: "100%-2",
        height: "100%-10",
        padding: 0,
        border: {
            type: "line",
        },
        style: {
            border: {
                fg: "green",
            },
        },
        
    });

    // Greet message
    let greetHeight = 0;
    if (greet) {
        const greetBox = blessed.box({
            parent: contentBox,
            top: 0,
            left: "center",
            width: "60%",
            height: 4,
            content: `{bold}${greet}{/bold}`,
            tags: true,
            align: "center",
            style: {
                fg: 'green',
            },
        });
        greetHeight = 4; 
    }

    // Upper section: URLs + Stats
    const upperSectionTop = greetHeight > 0 ? greetHeight : 0;

    const upperSection = blessed.box({
        parent: contentBox,
        top: upperSectionTop,
        left: 0,
        width: "100%-2", 
        height: 10,
    });

    // URLs section
    const urlsBox = blessed.box({
        parent: upperSection,
        top: 0,
        left: 0,
        width: "48%",
        height: "100%",
        padding: { left: 1, right: 1 },
        tags: true,
       
    });


    // Stats section
    const statsBox = blessed.box({
        parent: upperSection,
        top: 0,
        right: 0,
        left: "65%",
        width: "35%",
        height: "100%",
        padding: { left: 1, right: 1 },
        tags: true,
        align: "left",
    });

    // Lower section: Requests + QR Code
    const lowerSectionTop = greetHeight + 11;
    const lowerSection = blessed.box({
        parent: contentBox,
        top: lowerSectionTop,
        left: 0,
        right: 0,
        bottom: 2,
        width: "100%-2",
        height: `100%-${lowerSectionTop + 6}`,
    });

    const isQrCodeRequested = tunnelConfig?.qrCode || false;

    // Requests section
    const requestsBox = blessed.box({
        parent: lowerSection,
        top: 0,
        left: 0,
        width: isQrCodeRequested ? "60%" : "80%",
        height: "80%",
        padding: { left: 1, right: 1 },
        tags: true,
        scrollable: true,
        
    });

    // QR Code section
    let qrCodeBox: blessed.Widgets.BoxElement | undefined;
    if (isQrCodeRequested) {
        qrCodeBox = blessed.box({
            parent: lowerSection,
            top: 0,
            right: 0,
            width: "40%",
            height: "100%",
            tags: true,
            padding: { left: 1, right: 1 },
           
        });
    }

    // Footer
    const footerBox = blessed.box({
        parent: contentBox,
        bottom: 0,
        left: "center",
        width: "shrink",
        height: 1,
        content: "Press Ctrl+C to stop the tunnel. Or press h for key bindings.",
        tags: true,
    });

    return {
        mainContainer,
        logoBox,
        contentBox,
        urlsBox,
        statsBox,
        requestsBox,
        qrCodeBox,
        footerBox,
    };
}

/**
 * Creates a simple UI layout for narrower terminals
 */
export function createSimpleUI(
    screen: blessed.Widgets.Screen,
    urls: string[],
    greet: string
): UIElements {
    const mainContainer = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        padding: { left: 1, right: 1 },
    });

    let currentTop = 0;

    // Greet message
    if (greet) {
        blessed.box({
            parent: mainContainer,
            top: currentTop,
            left: "center",
            width: "90%",
            height: "shrink",
            content: `{bold}${greet}{/bold}`,
            tags: true,
            align: "center",
            style: {
                fg: 'green'
            }
        });

        const lines = Math.ceil(greet.length / ((screen.width as number) * 0.9));
        currentTop += Math.max(lines, 1) + 1;
    }

    // URLs section
    const urlsBox = blessed.box({
        parent: mainContainer,
        top: currentTop,
        left: 0,
        width: "100%",
        height: urls.length + 2,
        tags: true,
    });
    currentTop += urls.length + 3;

    // Stats section
    const statsBox = blessed.box({
        parent: mainContainer,
        top: currentTop,
        left: 0,
        width: "100%",
        height: 8,
        tags: true,
    });
    currentTop += 9;


    // Footer
    const footerBox = blessed.box({
        parent: mainContainer,
        bottom: 0,
        left: "center",
        width: "shrink",
        height: 1,
        content: "Press Ctrl+C to stop the tunnel.",
        tags: true,
        style: {
            fg: 'white',
        }
    });

    return {
        mainContainer,
        urlsBox,
        statsBox,
        footerBox,
    };
}
