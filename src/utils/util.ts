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
