#!/usr/bin/env node
/**
 * Rasterize the Studio app-icon master into Tauri's icon set.
 *
 * Source: `src-tauri/icons/icon-mark.svg` (copy of the presentation
 * `icon-mark.svg` Circuit-R tile). Re-copy the master, then re-run this.
 *
 * Usage (from apps/studio):
 *   node scripts/gen-icons.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const studioRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(studioRoot, 'src-tauri', 'icons');
const svgPath = join(iconsDir, 'icon-mark.svg');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  sharp = require(join(process.env.HOME ?? '', 'revfleet/revealui/apps/admin/node_modules/sharp'));
}

const png1024 = join(iconsDir, 'icon-1024.png');
await sharp(svgPath).resize(1024, 1024).png().toFile(png1024);

const tauri = spawnSync('pnpm', ['exec', 'tauri', 'icon', png1024, '--output', iconsDir], {
  cwd: studioRoot,
  stdio: 'inherit',
});
if (tauri.status !== 0) {
  process.exit(tauri.status ?? 1);
}

const { rmSync } = await import('node:fs');
for (const extra of ['android', 'ios']) {
  rmSync(join(iconsDir, extra), { recursive: true, force: true });
}
for (const extra of [
  'icon-1024.png',
  'StoreLogo.png',
  'Square30x30Logo.png',
  'Square44x44Logo.png',
  'Square71x71Logo.png',
  'Square89x89Logo.png',
  'Square107x107Logo.png',
  'Square142x142Logo.png',
  'Square150x150Logo.png',
  'Square284x284Logo.png',
  'Square310x310Logo.png',
]) {
  rmSync(join(iconsDir, extra), { force: true });
}

console.log(`brand icons: wrote Tauri set from ${svgPath}`);
