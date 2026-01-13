#!/usr/bin/env node

/**
 * Script to temporarily remove "type": "module" from package.json before running pkg
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');
const backupPath = join(__dirname, '..', 'package.json.backup');

function main() {
    const action = process.argv[2] || 'remove';

    if (action === 'remove') {
        removeTypeModule();
    } else if (action === 'restore') {
        restoreTypeModule();
    } else {
        console.error('Usage: node pre-pkg.js [remove|restore]');
        process.exit(1);
    }
}

function removeTypeModule() {
    try {
        // Read package.json
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        
        // Create backup if type module exists
        if (packageJson.type === 'module') {
            writeFileSync(backupPath, JSON.stringify(packageJson, null, 2));
            console.log('Backup created at package.json.backup');
            
            // Remove type module
            delete packageJson.type;
            
            // Write back to package.json
            writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
            console.log('Removed "type": "module" from package.json');
        } else {
            console.log('No "type": "module" found in package.json');
        }
    } catch (error) {
        console.error('Error removing type module:', error.message);
        process.exit(1);
    }
}

function restoreTypeModule() {
    try {
        if (existsSync(backupPath)) {
            // Restore from backup
            const backupContent = readFileSync(backupPath, 'utf8');
            writeFileSync(packageJsonPath, backupContent);
            
            // Remove backup file
            unlinkSync(backupPath);
            
            console.log('Restored package.json from backup');
        } else {
            console.log('No backup file found, nothing to restore');
        }
    } catch (error) {
        console.error('Error restoring package.json:', error.message);
        process.exit(1);
    }
}

main();
