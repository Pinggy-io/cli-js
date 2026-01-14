import pico from 'picocolors';

interface Spinner {
    interval: number;
    frames: string[];
}

interface Spinners {
    [key: string]: Spinner;
}

export const spinners: Spinners = {
    dots: {
        interval: 80,
        frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    },
};

let currentTimer: NodeJS.Timeout | null = null;
let currentText = '';

export function startSpinner(name = 'dots', text = 'Loading') {
    const spinner = spinners[name];
    let i = 0;
    currentText = text;

    // Clear any existing spinner
    if (currentTimer) {
        clearInterval(currentTimer);
    }

    currentTimer = setInterval(() => {
        const frame = spinner.frames[i = ++i % spinner.frames.length];
        process.stdout.write(`\r${pico.cyan(frame)} ${text}`);
    }, spinner.interval);

    return () => stopSpinner();
}

export function stopSpinner() {
    if (currentTimer) {
        clearInterval(currentTimer);
        currentTimer = null;
        process.stdout.write('\r\x1b[K'); // Clear the line
    }
}

export function stopSpinnerSuccess(message?: string) {
    if (currentTimer) {
        clearInterval(currentTimer);
        currentTimer = null;
        const finalMessage = message || currentText;
        process.stdout.write(`\r${pico.green('✔')} ${finalMessage}\n`);
    }
}

export function stopSpinnerFail(message?: string) {
    if (currentTimer) {
        clearInterval(currentTimer);
        currentTimer = null;
        const finalMessage = message || currentText;
        process.stdout.write(`\r${pico.red('✖')} ${finalMessage}\n`);
    }
}
