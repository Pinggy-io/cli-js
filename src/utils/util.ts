import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import CLIPrinter from './printer.js';

export function getRandomId() {
    return randomUUID();
}

export function isValidPort(p: number): boolean {
    return Number.isInteger(p) && p > 0 && p < 65536;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getVersion(): string {
    try {
        const packageJsonPath = join(__dirname, '../package.json');
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        return pkg.version ?? '';
    } catch (error) {
        CLIPrinter.error('Error reading version info');
        return '';
    }
}

export function getLocalAddress(config: any): string {
    if (!config) return "-";
    if (config.forwarding) {
        if (typeof config.forwarding === "string") return config.forwarding;
        if (Array.isArray(config.forwarding) && config.forwarding.length > 0) {
            const f = config.forwarding[0];
            if (f.address) return f.address;
            if (f.localDomain && f.localPort) return `${f.localDomain}:${f.localPort}`;
        }
    }
    if (config.localAddress) return config.localAddress;
    return "-";
}
