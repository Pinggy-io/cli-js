#!/usr/bin/env node

/**
 * Refuses a Linux native file that the packaged binary cannot load on the distros it supports.
 *
 * Usage: node scripts/check_linux_addons.js <x64|arm64>
 *
 * It checks node-pty's pty.node and the SDK's addon.node and libpinggy.so. libpinggy.so needs the
 * system's OpenSSL 3, so the oldest distro the CLI runs on is RHEL 9: glibc 2.34, and GCC 11's
 * libgcc_s and libstdc++. A native file needs the symbol versions of the machine that compiled it.
 * pty.node compiled on Ubuntu 26.04 needs GLIBC_2.42, and the terminal then stays off on Ubuntu 24.04.
 * scripts/build_node_pty_linux.sh compiles it on Debian 12. The SDK's files come prebuilt, unless the
 * download fails and node-pre-gyp compiles them on this machine.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const NODE_PTY_REMEDY = 'Run npm ci on Linux, then scripts/build_node_pty_linux.sh, on the architecture the binary targets.';
const SDK_REMEDY = 'Run npm ci again on Linux, on the architecture the binary targets, so it downloads the SDK\'s prebuilt files.';

const NATIVE_FILES = [
    { file: 'node_modules/node-pty/build/Release/pty.node', remedy: NODE_PTY_REMEDY },
    { file: 'node_modules/@pinggy/pinggy/lib/addon.node', remedy: SDK_REMEDY },
    { file: 'node_modules/@pinggy/pinggy/lib/libpinggy.so', remedy: SDK_REMEDY },
];

/**
 * The newest version of each family a file may need, from RHEL 9's libraries. On x64 its libgcc_s
 * defines up to GCC_7.0.0, and on arm64 up to GCC_11.0.
 */
const LIMITS = { GLIBC: '2.34', GLIBCXX: '3.4.29', CXXABI: '1.3.13', GCC: '7.0.0' };

// GLIBCXX before GLIBC, so the alternation takes the longer name.
const FAMILY_VERSION = /^(GLIBCXX|CXXABI|GLIBC|GCC)_(.+)$/;
const NUMBERED = /^[0-9]+(\.[0-9]+)*$/;

/** ELF `e_machine` values. */
const MACHINES = { x64: 62, arm64: 183 };
const ELF_MAGIC = '\x7fELF';

// Byte offsets in an ELF64 file: the file header, a section header, and the Verneed and Vernaux
// entries of the .gnu.version_r section.
const HEADER = { machine: 18, sectionsAt: 0x28, sectionSize: 0x3a, sectionCount: 0x3c };
const SECTION = { type: 4, offset: 24, link: 40, info: 44 };
const VERNEED = { auxCount: 2, auxAt: 8, next: 12 };
const VERNAUX = { name: 8, next: 12 };
const SHT_GNU_VERNEED = 0x6ffffffe;

function fail(message, hint) {
    console.error(`check_linux_addons: ${message}`);
    if (hint) console.error(hint);
    process.exit(1);
}

function compareVersions(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

function machineName(code) {
    const name = Object.keys(MACHINES).find((arch) => MACHINES[arch] === code);
    return name ?? `ELF machine ${code}`;
}

function checkArchitecture(elf, { file, remedy }, arch) {
    if (elf.toString('latin1', 0, 4) !== ELF_MAGIC) fail(`${file} is not an ELF file.`, remedy);
    const machine = elf.readUInt16LE(HEADER.machine);
    if (machine !== MACHINES[arch]) fail(`${file} is built for ${machineName(machine)}, and the binary targets ${arch}.`, remedy);
}

function sectionHeaders(elf) {
    const start = Number(elf.readBigUInt64LE(HEADER.sectionsAt));
    const size = elf.readUInt16LE(HEADER.sectionSize);
    return Array.from({ length: elf.readUInt16LE(HEADER.sectionCount) }, (_, index) => {
        const header = start + index * size;
        return {
            type: elf.readUInt32LE(header + SECTION.type),
            offset: Number(elf.readBigUInt64LE(header + SECTION.offset)),
            link: elf.readUInt32LE(header + SECTION.link),
            info: elf.readUInt32LE(header + SECTION.info),
        };
    });
}

function readString(elf, offset) {
    return elf.toString('latin1', offset, elf.indexOf(0, offset));
}

/** The version names 1 Verneed entry asks of its library. */
function entryVersionNames(elf, entry, strings) {
    const names = [];
    let aux = entry + elf.readUInt32LE(entry + VERNEED.auxAt);
    for (let i = 0; i < elf.readUInt16LE(entry + VERNEED.auxCount); i++) {
        names.push(readString(elf, strings + elf.readUInt32LE(aux + VERNAUX.name)));
        aux += elf.readUInt32LE(aux + VERNAUX.next);
    }
    return names;
}

/** Every symbol version the file needs, from its .gnu.version_r section. */
function neededVersions(elf, { file, remedy }) {
    const sections = sectionHeaders(elf);
    if (sections.length === 0) fail(`${file} has no section headers, so its symbol versions cannot be read.`, remedy);
    const verneed = sections.find((section) => section.type === SHT_GNU_VERNEED);
    if (!verneed) return [];
    const strings = sections[verneed.link].offset;
    const names = [];
    let entry = verneed.offset;
    for (let i = 0; i < verneed.info; i++) {
        names.push(...entryVersionNames(elf, entry, strings));
        entry += elf.readUInt32LE(entry + VERNEED.next);
    }
    return names;
}

/**
 * The newest numbered version per family, and the family's names that carry no number, such as
 * GLIBC_ABI_DT_RELR (glibc 2.36). Names of other libraries, such as libssl.so.3's OPENSSL_3.0.0, are
 * not this check's to judge.
 */
function sortVersions(names) {
    const newest = {};
    const unnumbered = [];
    for (const name of names) {
        const match = FAMILY_VERSION.exec(name);
        if (!match) continue;
        const [, family, version] = match;
        if (!NUMBERED.test(version)) unnumbered.push(name);
        else if (!newest[family] || compareVersions(version, newest[family]) > 0) newest[family] = version;
    }
    return { newest, unnumbered };
}

function checkVersions({ newest, unnumbered }, { file, remedy }) {
    const tooNew = Object.entries(newest)
        .filter(([family, version]) => compareVersions(version, LIMITS[family]) > 0)
        .map(([family, version]) => `${family}_${version} (limit ${family}_${LIMITS[family]})`);
    const refused = [...tooNew, ...unnumbered.map((name) => `${name} (not a numbered version)`)];
    if (refused.length > 0) fail(`${file} needs ${refused.join(', ')}. It would not load on RHEL 9.`, remedy);
}

function checkFile(nativeFile, arch) {
    const path = join(ROOT, nativeFile.file);
    if (!existsSync(path)) fail(`${nativeFile.file} is missing.`, nativeFile.remedy);
    const elf = readFileSync(path);
    checkArchitecture(elf, nativeFile, arch);
    const versions = sortVersions(neededVersions(elf, nativeFile));
    checkVersions(versions, nativeFile);
    const needs = Object.entries(versions.newest).map(([family, version]) => `${family}_${version}`).join(', ');
    console.log(`check_linux_addons: ${nativeFile.file} is ${arch} and needs ${needs}.`);
}

function main() {
    const arch = process.argv[2];
    if (!MACHINES[arch]) fail(`usage: node scripts/check_linux_addons.js <${Object.keys(MACHINES).join('|')}>`);
    for (const nativeFile of NATIVE_FILES) checkFile(nativeFile, arch);
}

main();
