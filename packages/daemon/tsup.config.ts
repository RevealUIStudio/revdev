import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'storage/index': 'src/storage/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node24',
  external: ['@electric-sql/pglite'],
});
