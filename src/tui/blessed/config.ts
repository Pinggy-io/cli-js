/**
 * TUI Configuration Settings
 */

export interface TuiConfig {
    /**
     * Maximum number of request/response pairs to keep in memory.
     * Older requests will be removed when this limit is exceeded.
     * Default: 100
     */
    maxRequestPairs: number;

    /**
     * Number of visible request items to display in the requests box.
     * Default: 10
     */
    visibleRequestCount: number;

    /**
     * Margin from the viewport edge when auto-scrolling to keep selector visible.
     * Default: 2
     */
    viewportScrollMargin: number;

    /**
     * Inactivity timeout in milliseconds to auto-unselect the selected row and adjust viewport to latest request.
     * Default: 10000 (10 seconds)
     */

    inactivityHttpSelectorTimeoutMs?: number;
}

/**
 * Default TUI configuration values
 */
export const defaultTuiConfig: TuiConfig = {
    maxRequestPairs: 100,
    visibleRequestCount: 10,
    viewportScrollMargin: 2,
    inactivityHttpSelectorTimeoutMs: 10000,
};

/**
 * Get the current TUI configuration.
 */
export function getTuiConfig(): TuiConfig {
    return {
        maxRequestPairs: defaultTuiConfig.maxRequestPairs,
        visibleRequestCount:defaultTuiConfig.visibleRequestCount,
        viewportScrollMargin: defaultTuiConfig.viewportScrollMargin,
        inactivityHttpSelectorTimeoutMs: defaultTuiConfig.inactivityHttpSelectorTimeoutMs,
    };
}
