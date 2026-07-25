import { defineConfig } from 'vitest/config';

// Root-level config for CI helper scripts under scripts/**. Those scripts are
// not workspace packages (pnpm-workspace.yaml scopes to apps/* and
// packages/*), so they run under this dedicated root config rather than
// `pnpm -r test`, which only recurses into workspace members.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
  },
});
