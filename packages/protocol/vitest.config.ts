import { defineConfig } from 'vitest/config';

// `build` compiles the whole of `src` (including `src/__tests__`) into
// `dist/__tests__/*.test.js`. Vitest's default excludes don't reliably keep
// those compiled copies out of discovery once `dist` exists locally, which
// double-runs every test against a possibly-stale build. Scope discovery to
// the TypeScript sources.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
