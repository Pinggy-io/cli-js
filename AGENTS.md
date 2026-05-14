# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pinggy CLI (`@pinggy/cli`) — a Node.js CLI tool for creating and managing Pinggy tunnels. Built with TypeScript, it wraps the `@pinggy/pinggy` SDK and provides a terminal UI (blessed), remote management via WebSocket, and built-in file serving.

## Common Commands

```bash
# Build (produces CJS + ESM in dist/)
npm run build

# Run tests (Jest with ESM support)
node --experimental-vm-modules node_modules/jest/bin/jest.js
# Or simply:
npm test

# Run a single test file
node --experimental-vm-modules node_modules/jest/bin/jest.js src/_tests_/tunnelManager.test.ts

# TypeScript type-check only (output to dist_tsc/)
npm run build:tsc

# Dev workflow (link SDK, build, link locally)
npm run dev

# Build platform binaries (via pkg)
npm run pack:all
```

## Architecture

**Entry flow:** `index.ts` → `main.ts` → `cli/startCli.ts` → TunnelManager + TUI

**Key modules:**

- **`src/cli/`** — CLI argument parsing and config building. `parseArgs()` is custom (not Node's `parseArgs`) to handle SSH-style flags like `-R` and `-L` with attached values. Config pipeline: CLI args → `parseUserAndDomain()` → extended options → `buildFinalConfig()` (merges defaults + config file + CLI overrides).

- **`src/tunnel_manager/TunnelManager.ts`** — Singleton orchestrator. Manages `ManagedTunnel` instances indexed by both `tunnelId` and `configId`. Uses observer pattern with typed listener maps (`Map<tunnelId, Map<listenerId, fn>>`) for stats, errors, disconnects, and reconnections.

- **`src/remote_management/`** — WebSocket-based remote control from the Pinggy dashboard. `WebSocketCommandHandler` dispatches commands, `TunnelOperations` executes them. Request/response payloads validated with Zod schemas (`remote_schema.ts`). Auto-reconnects with 5s retry.

- **`src/tui/blessed/`** — Interactive terminal UI using the `blessed` library. `TunnelTui` manages screen lifecycle, modals, key bindings, and a web debugger WebSocket connection for real-time request/response display. QR codes rendered inline.

- **`src/utils/`** — `FileServer.ts` (HTTP server for `--serve` mode, runs in worker thread), `parseArgs.ts` (custom arg parser), `printer.ts` (CLIPrinter singleton for styled output).

**Core types** are in `src/types.ts`: `TunnelStatus`, `Status`, `TunnelStateType` enum (idle/starting/running/live/closed/exited), `FinalConfig` (extends SDK's `TunnelConfigurationV1`).

## Build System

- **tsup** bundles for production (CJS + ESM, entry: `src/index.ts` + `src/workers/file_serve_worker.ts`)
- **tsc** used only for type-checking (`build:tsc`)
- **pkg** creates standalone binaries per platform
- **ts-jest** with ESM preset for tests (configured in `jest.config.cjs`, uses `tsconfig.jest.json`)

## Testing

Tests live in `src/_tests_/`. Jest with `@jest/globals` imports (not global jest). The TunnelManager singleton must be reset between tests: `TunnelManager.instance = undefined`. Run `jest.clearAllMocks()` in `beforeEach`.

## Key Patterns

- **Singletons**: TunnelManager, logger (Winston), CLIPrinter — accessed via `getInstance()` or static methods
- **Listener/observer maps** for tunnel events — register/unregister by listenerId per tunnelId
- **Zod validation** on all remote management payloads (V1 and V2 schemas)
- **Worker threads** for file serving (`file_serve_worker.ts`)
- **Config files**: tunnels can load config from JSON (`--conf`) and save back (`--saveconf`)

## English Style

- **No em-dashes.** Use a period, colon, or restructure the sentence. No obvious characters or constructions used by LLMs and AI.
- **Short phrases.** Enough to convey technical meaning. Nothing more.
- **No filler words.** Cut: "in order to", "it is important to note", "please note that", "essentially", "basically", "simply".
- **No passive voice** unless the subject is unknown or irrelevant.
- **No nominalizations.** Prefer "detect" over "perform detection"; "configure" over "apply configuration".
- **One idea per sentence.** Split compound sentences.
- **No throat-clearing openers.** Never start with "This document describes...", "The purpose of this is...", "As mentioned above...".
- **Prefer concrete over abstract.** Name the thing: `navigator.webdriver`, not "the relevant browser property".
- **Present tense.** "The system routes requests." Not "The system will route requests."
- **No redundant qualifiers.** "Persistent storage" not "persistent, durable, long-lived storage".
- **Numbers.** Use digits for all quantities: "3 retries", "50 sessions", "300ms".

## Code Style
- **No dead code.** Remove unused imports, functions, and variables immediately. `ruff` enforces this.
- **Small functions.** If a function needs a comment to explain its sections, split it.