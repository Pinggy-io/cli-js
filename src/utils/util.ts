import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';

export function getRandomId() {
    return randomUUID();
}

export function isValidPort(p: number): boolean {
    return Number.isInteger(p) && p > 0 && p < 65536;
}

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export function getVersion(): string {
    return pkg.version ?? '';
}
