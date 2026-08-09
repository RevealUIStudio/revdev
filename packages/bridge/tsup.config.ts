import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: false,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@revdev/protocol',
    '@revealui/knowledge-graph',
    '@revealui/knowledge-graph/ingest',
    '@revealui/db',
    '@revealui/db/pool',
    '@revealui/ai',
    '@revealui/ai/embeddings',
  ],
});
