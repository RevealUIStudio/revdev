import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIco } from '../apps/studio/scripts/gen-icons.mjs';

const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'revdev-studio-generation-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Studio generators', () => {
  it('does not resolve sharp from a sibling checkout when the Studio dependency is absent', () => {
    const root = temporaryRoot();
    const script = join(root, 'apps/studio/scripts/gen-icons.mjs');
    const siblingSharp = join(root, 'home/revealfleet/revealui/apps/admin/node_modules/sharp');
    const marker = join(root, 'sibling-sharp-was-loaded');
    mkdirSync(join(root, 'apps/studio/scripts'), { recursive: true });
    mkdirSync(siblingSharp, { recursive: true });
    writeFileSync(
      script,
      readFileSync(new URL('../apps/studio/scripts/gen-icons.mjs', import.meta.url)),
    );
    writeFileSync(
      join(siblingSharp, 'package.json'),
      JSON.stringify({ name: 'sharp', version: '0.0.0', type: 'module', main: 'index.js' }),
    );
    writeFileSync(
      join(siblingSharp, 'index.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default {};`,
    );

    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, HOME: join(root, 'home') },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Cannot find package 'sharp'");
    expect(() => readFileSync(marker, 'utf8')).toThrow();
  });

  it('replaces generated types with a fresh export set and removes stale bindings', () => {
    const { result, generatedDir } = runTypeGenerator('success');
    expect(result.status).toBe(0);
    expect(readFileSync(join(generatedDir, 'Fresh.ts'), 'utf8')).toContain('fresh');
    expect(readFileSync(join(generatedDir, 'Nested.ts'), 'utf8')).toContain('nested');
    expect(() => readFileSync(join(generatedDir, 'Stale.ts'), 'utf8')).toThrow();
  });

  it.each([
    'empty',
    'duplicate',
    'fail',
  ])('fails closed and preserves the prior generated set for %s exports', (mode) => {
    const { result, generatedDir } = runTypeGenerator(mode);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(generatedDir, 'Existing.ts'), 'utf8')).toBe('existing');
  });

  it('retains the only prior generated set if publishing and restoration both fail', () => {
    const { result, studio } = runTypeGenerator('restore-fail');
    const stagingDirs = readdirSync(studio).filter((name) => name.startsWith('.generate-types.'));

    expect(result.status).not.toBe(0);
    expect(stagingDirs).toHaveLength(1);
    expect(readFileSync(join(studio, stagingDirs[0], 'previous/Existing.ts'), 'utf8')).toBe(
      'existing',
    );
    expect(result.stderr).toContain('backup retained at');
  });
});

function runTypeGenerator(mode) {
  const root = temporaryRoot();
  const studio = join(root, 'apps/studio');
  const tauri = join(studio, 'src-tauri');
  const generatedDir = join(studio, 'src/generated');
  const bin = join(root, 'bin');
  mkdirSync(join(studio, 'scripts'), { recursive: true });
  mkdirSync(join(tauri, 'wsl'), { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(studio, 'scripts/generate-types.sh'),
    readFileSync(new URL('../apps/studio/scripts/generate-types.sh', import.meta.url)),
  );
  writeFileSync(join(tauri, 'wsl/revdev-relay'), 'relay');
  writeFileSync(join(generatedDir, 'Existing.ts'), 'existing');
  writeFileSync(join(generatedDir, 'Stale.ts'), 'stale');

  const cargo = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"test --lib"* ]]; then
  case "$MODE" in
    success|duplicate|restore-fail)
      printf 'export const fresh = true;\\n' > "$TS_RS_EXPORT_DIR/Fresh.ts"
      mkdir -p "$TS_RS_EXPORT_DIR/bindings"
      printf 'export const nested = true;\\n' > "$TS_RS_EXPORT_DIR/bindings/Nested.ts"
      if [[ "$MODE" == duplicate ]]; then cp "$TS_RS_EXPORT_DIR/Fresh.ts" "$TS_RS_EXPORT_DIR/bindings/Fresh.ts"; fi
      ;;
    fail) exit 23 ;;
    empty) ;;
  esac
fi
`;
  writeFileSync(join(bin, 'cargo'), cargo, { mode: 0o755 });
  if (mode === 'restore-fail') {
    writeFileSync(
      join(bin, 'mv'),
      '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == */output || "$1" == */previous ]]; then exit 1; fi\nexec /usr/bin/mv "$@"\n',
      { mode: 0o755 },
    );
  }

  const result = spawnSync('bash', [join(studio, 'scripts/generate-types.sh')], {
    env: { ...process.env, MODE: mode, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return { result, generatedDir, studio };
}

describe('ICO payload dimensions', () => {
  const png = readFileSync(new URL('../apps/studio/src-tauri/icons/32x32.png', import.meta.url));
  it('preserves original PNG bytes and encodes matching directory dimensions', () => {
    const ico = buildIco([{ width: 32, png }]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(1);
    expect(ico[6]).toBe(32);
    expect(ico[7]).toBe(32);
    expect(ico.readUInt32LE(14)).toBe(png.length);
    const offset = ico.readUInt32LE(18);
    expect(offset).toBe(22);
    expect(ico.subarray(offset)).toEqual(png);
  });
  it('encodes the valid 256px PNG using the ICO zero-byte dimension convention', () => {
    const large = readFileSync(
      new URL('../apps/studio/src-tauri/icons/128x128@2x.png', import.meta.url),
    );
    expect(large.readUInt32BE(16)).toBe(256);
    const ico = buildIco([{ width: 256, png: large }]);
    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
    expect(ico.subarray(ico.readUInt32LE(18))).toEqual(large);
  });
  it('keeps every checked-in ICO directory entry consistent with its embedded PNG', () => {
    const ico = readFileSync(new URL('../apps/studio/src-tauri/icons/icon.ico', import.meta.url));
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(5);
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16;
      const width = ico[entry] || 256;
      const height = ico[entry + 1] || 256;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset).toBeGreaterThanOrEqual(6 + count * 16);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      const payload = ico.subarray(offset, offset + length);
      expect(payload.toString('ascii', 12, 16)).toBe('IHDR');
      expect(payload.readUInt32BE(16)).toBe(width);
      expect(payload.readUInt32BE(20)).toBe(height);
    }
  });
  it('rejects the audited 256px directory and 512px payload mismatch', () => {
    const large = readFileSync(new URL('../apps/studio/src-tauri/icons/icon.png', import.meta.url));
    expect(large.readUInt32BE(16)).toBe(512);
    expect(() => buildIco([{ width: 256, png: large }])).toThrow('differs from PNG payload');
  });
  it.each([0, 257, 1.5, NaN])('rejects an invalid directory dimension %s', (width) => {
    expect(() => buildIco([{ width, png }])).toThrow('dimensions');
  });
  it('rejects truncated, invalid, rectangular and duplicate payload entries', () => {
    expect(() => buildIco([])).toThrow('nonempty');
    expect(() => buildIco([{ width: 32, png: png.subarray(0, 24) }])).toThrow('IHDR');
    expect(() => buildIco([{ width: 32, png: Buffer.alloc(33) }])).toThrow('IHDR');
    const rectangle = Buffer.from(png);
    rectangle.writeUInt32BE(16, 20);
    expect(() => buildIco([{ width: 32, png: rectangle }])).toThrow('differs from PNG payload');
    expect(() =>
      buildIco([
        { width: 32, png },
        { width: 32, png },
      ]),
    ).toThrow('dimensions');
  });
});
