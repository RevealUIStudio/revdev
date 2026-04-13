import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'storage/index': 'src/storage/index.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node24',
  banner: { js: '' },
  external: ['@electric-sql/pglite'],
});
