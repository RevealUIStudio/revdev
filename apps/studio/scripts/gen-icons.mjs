#!/usr/bin/env node
/**
 * Rasterize Studio app icons from the design-system masters.
 *
 * - `icon-mark.svg` (tiled Circuit-R) for 32px and up
 * - `mark-untiled.svg` (flat mark) for 16/24 so the taskbar is not a smudge
 *
 * Usage (from apps/studio):
 *   node scripts/gen-icons.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(studioRoot, 'src-tauri', 'icons');
const tiled = join(iconsDir, 'icon-mark.svg');
const untiled = join(iconsDir, 'mark-untiled.svg');

export async function generateIcons() {
  // `sharp` is a direct Studio dev dependency. Fail at the owning package's
  // resolver boundary instead of borrowing another checkout's installation.
  const sharp = (await import('sharp')).default;

  const png1024 = join(iconsDir, 'icon-1024.png');
  await sharp(tiled).resize(1024, 1024).png().toFile(png1024);

  const tauri = spawnSync('pnpm', ['exec', 'tauri', 'icon', png1024, '--output', iconsDir], {
    cwd: studioRoot,
    stdio: 'inherit',
  });
  if (tauri.status !== 0) {
    process.exit(tauri.status ?? 1);
  }

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

  // Brand size floor: <=24px is the untiled mark, not the downscaled tile.
  const png16 = await sharp(untiled).resize(16, 16).png().toBuffer();
  const png24 = await sharp(untiled).resize(24, 24).png().toBuffer();
  const png32 = readFileSync(join(iconsDir, '32x32.png'));
  const png64 = readFileSync(join(iconsDir, '64x64.png'));
  const png256 = await sharp(join(iconsDir, 'icon.png')).resize(256, 256).png().toBuffer();

  writeFileSync(
    join(iconsDir, 'icon.ico'),
    buildIco([
      { width: 16, png: png16 },
      { width: 24, png: png24 },
      { width: 32, png: png32 },
      { width: 64, png: png64 },
      { width: 256, png: png256 },
    ]),
  );

  console.log('brand icons: tiled 32+ from icon-mark.svg, 16/24 from mark-untiled.svg');
}

export function buildIco(images) {
  if (!Array.isArray(images) || !images.length || images.length > 256)
    throw new Error('ICO requires a nonempty bounded image set');
  const widths = new Set();
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const { width, png } of images) {
    if (!Number.isInteger(width) || width < 1 || width > 256 || widths.has(width))
      throw new Error('ICO dimensions must be unique integers between 1 and 256');
    widths.add(width);
    if (
      !Buffer.isBuffer(png) ||
      png.length < 33 ||
      !png.subarray(0, 8).equals(signature) ||
      png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new Error('ICO payload must begin with a complete PNG IHDR');
    if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== width)
      throw new Error(`ICO directory dimension ${width} differs from PNG payload`);
  }
  const headerSize = 6;
  const entrySize = 16;
  const dir = Buffer.alloc(headerSize + entrySize * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  const parts = [dir];
  images.forEach((img, i) => {
    const at = headerSize + i * entrySize;
    dir.writeUInt8(img.width === 256 ? 0 : img.width, at);
    dir.writeUInt8(img.width === 256 ? 0 : img.width, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(img.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    parts.push(img.png);
    offset += img.png.length;
  });
  return Buffer.concat(parts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateIcons();
}
