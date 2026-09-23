import { defineConfig } from 'vitest/config';

// Scope discovery to TypeScript sources so a later `dist/` emit cannot
// double-run compiled copies of the same tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
