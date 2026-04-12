import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['@revdev/protocol'],
});
