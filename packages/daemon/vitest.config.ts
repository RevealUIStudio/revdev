import { freemem } from 'node:os';
import { defineConfig } from 'vitest/config';

// ---------------------------------------------------------------------------
// Resource-aware daemon test configuration.
//
// The daemon integration tests each spin up a FULL daemon in `beforeAll`/`beforeEach`
// (Unix socket + PGlite DB + git/PTY): filegit-*, e2e-ipc, shutdown-drain, spawn.
// Running many of those files concurrently on a low-memory machine starves
// CPU/RAM, and the daemon boot blows past vitest's default hook timeout
// (observed: 30s `beforeAll` timeouts under load; 0 assertions fail — the suite
// is correct, just starved).
//
// The durable fix is to BOUND how many heavy daemons boot at once rather than to
// keep inflating the timeout. Mirrors the revealui root vitest.config.ts
// resource-aware worker cap. The timeouts below are modest safety margins for a
// genuine (no-longer-starved) daemon boot + teardown, not the primary lever.
// ---------------------------------------------------------------------------

const availableMb = Math.floor(freemem() / 1024 / 1024);
const maxWorkers = availableMb > 4096 ? 4 : 2;

export default defineConfig({
  test: {
    maxWorkers,
    minWorkers: 1,
    hookTimeout: 45_000,
    testTimeout: 30_000,
  },
});
