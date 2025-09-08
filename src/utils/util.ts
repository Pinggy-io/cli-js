export function isValidPort(p: number): boolean {
    return Number.isInteger(p) && p > 0 && p < 65536;
}
