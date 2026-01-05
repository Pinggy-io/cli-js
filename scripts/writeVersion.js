import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export default function writeVersion() {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const rootDir = join(__dirname, '..');

    // Read version from package.json
    const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    const version = packageJson.version;

    // Write version to a separate JSON file in dist_tsc (where compiled files go)
    const versionInfo = {
        version: version,
    };

    // Write to dist_tsc directory
    const distPath = join(rootDir, 'dist_tsc', 'version.json');
    writeFileSync(distPath, JSON.stringify(versionInfo, null, 2));

    console.log(`Version ${version} written to dist_tsc/version.json`);

    // Also write to src
    const srcPath = join(rootDir, 'src', 'version.json');
    writeFileSync(srcPath, JSON.stringify(versionInfo, null, 2));

    console.log(`Version ${version} written to src/version.json`);
}
