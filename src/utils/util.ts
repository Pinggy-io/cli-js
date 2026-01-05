import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export function isValidPort(p: number): boolean {
    return Number.isInteger(p) && p > 0 && p < 65536;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionPath = join(__dirname, '..', 'version.json');
const versionInfo = JSON.parse(readFileSync(versionPath, 'utf-8'));

export function getVersion(): string {
    return versionInfo.version ?? '';
}
