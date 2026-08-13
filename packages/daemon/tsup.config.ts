import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'agent-identity-crypto': 'src/agent-identity-crypto.ts',
    'storage/index': 'src/storage/index.ts',
    'tool-guard/sync-vendored': 'src/tool-guard/sync-vendored.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node24',
  banner: { js: '' },
  external: ['@electric-sql/pglite'],
  // Bundle undici so systemd `node dist/cli.js` does not need a hoisted install.
  noExternal: ['undici'],
});
