import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FEED =
  'https://github.com/revealui-studio/revdev/releases/download/studio-latest/latest.json';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('studio updater feed owner', () => {
  it('points the releases upstream at the moved repository', () => {
    const feed = source('../../apps/releases/api/latest.js');
    expect(feed).toContain(FEED);
    expect(feed.includes('github.com/RevealUIStudio/revdev')).toBe(false);
  });
});
