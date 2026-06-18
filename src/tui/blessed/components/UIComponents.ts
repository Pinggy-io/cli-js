import blessed from "blessed";
import { FinalConfig } from "../../../types.js";
import { asciiArtPinggyLogo, asciiArtPinggyLogoCompact, asciiArtPinggyLogoMedium } from "../../ink/asciArt.js";

export const MIN_WIDTH_WARNING = 60;
export const SIMPLE_LAYOUT_THRESHOLD = 80;
export const MEDIUM_LOGO_THRESHOLD = 100;
export const FULL_LOGO_THRESHOLD = 120;
export const MEDIUM_LOGO_HEIGHT_THRESHOLD = 26;
export const FULL_LOGO_HEIGHT_THRESHOLD = 34;

export interface UIElements {
    mainContainer: blessed.Widgets.BoxElement;
    logoBox?: blessed.Widgets.BoxElement;
    contentBox?: blessed.Widgets.BoxElement;
    urlsBox?: blessed.Widgets.BoxElement;
    statsBox?: blessed.Widgets.BoxElement;
    requestsBox?: blessed.Widgets.BoxElement;
    qrCodeBox?: blessed.Widgets.BoxElement;
    footerBox?: blessed.Widgets.BoxElement;
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
 * Colorizes a single-line wordmark with a gradient applied per character
 */
export function colorizeGradientHorizontal(text: string): string {
    const colors = ["red", "yellow", "green", "cyan", "blue", "magenta"];
    let colorIndex = 0;
    return [...text]
        .map((char) => {
            if (char === " ") return char;
            const color = colors[colorIndex % colors.length];
            colorIndex++;
            return `{${color}-fg}${char}{/${color}-fg}`;
        })
        .join("");
}

/**
 * Picks the logo variant that fits the terminal. 
 */
export function selectLogo(width: number, height: number): { content: string; boxHeight: number } {
    const widthTier = width >= FULL_LOGO_THRESHOLD ? 2 : width >= MEDIUM_LOGO_THRESHOLD ? 1 : 0;
    const heightTier = height >= FULL_LOGO_HEIGHT_THRESHOLD ? 2 : height >= MEDIUM_LOGO_HEIGHT_THRESHOLD ? 1 : 0;
    const tier = Math.min(widthTier, heightTier);

    if (tier === 2) {
        return { content: colorizeGradient(asciiArtPinggyLogo), boxHeight: 7 };
    }
    if (tier === 1) {
        return { content: colorizeGradient(asciiArtPinggyLogoMedium), boxHeight: 5 };
    }
    return {
        content: `{bold}${colorizeGradientHorizontal(asciiArtPinggyLogoCompact)}{/bold}`,
        boxHeight: 1,
    };
}

/**
 * Wraps text at word boundaries so blessed never hard-breaks a long token
 * (like a URL) mid-word. Only a single word longer than the width is split.
 */
export function wrapText(text: string, width: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= width) {
            current = candidate;
            continue;
        }
        if (current) {
            lines.push(current);
            current = "";
        }
        let rest = word;
        while (rest.length > width) {
            lines.push(rest.slice(0, width));
            rest = rest.slice(width);
        }
        current = rest;
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
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

    // Logo size scales with both terminal width and height
    const { content: logoContent, boxHeight: logoHeight } = selectLogo(
        screen.width as number,
        screen.height as number
    );

    const logoBox = blessed.box({
        parent: mainContainer,
        top: 0,
        left: 0,
        width: "100%",
        height: logoHeight,
        content: logoContent,
        tags: true,
    });

    // Content box with border
    const contentTop = logoHeight + 1;
    const contentBox = blessed.box({
        parent: mainContainer,
        top: contentTop,
        left: 0,
        width: "100%-2",
        height: `100%-${contentTop + 2}`,
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

    // Greet message: pre-wrap at word boundaries so URLs are never broken mid-word
    let greetHeight = 0;
    if (greet) {
        const contentInnerWidth = (screen.width as number) - 6;
        const greetWidth = Math.max(20, Math.floor(contentInnerWidth * 0.6));
        const greetLines = wrapText(greet, greetWidth);
        const greetBoxHeight = greetLines.length + 1;

        blessed.box({
            parent: contentBox,
            top: 0,
            left: "center",
            width: greetWidth,
            height: greetBoxHeight,
            content: greetLines.map((line) => `{bold}${line}{/bold}`).join("\n"),
            tags: true,
            align: "center",
            style: {
                fg: 'green',
            },
        });
        greetHeight = greetBoxHeight;
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

    const isQrCodeRequested = tunnelConfig?.isQRCode || false;

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

    // Greet message: pre-wrap at word boundaries so URLs are never broken mid-word
    if (greet) {
        const greetWidth = Math.max(20, Math.floor(((screen.width as number) - 2) * 0.9));
        const greetLines = wrapText(greet, greetWidth);
        blessed.box({
            parent: mainContainer,
            top: currentTop,
            left: "center",
            width: greetWidth,
            height: greetLines.length,
            content: greetLines.map((line) => `{bold}${line}{/bold}`).join("\n"),
            tags: true,
            align: "center",
            style: {
                fg: 'green'
            }
        });

        currentTop += greetLines.length + 1;
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
