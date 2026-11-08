// Draws the extension icons (a split keyboard on a rounded tile) as PNGs without dependencies.
// Run: node tools/make-icons.mjs  ->  monkeytype/icons/icon-{16,32,48,128}.png

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'monkeytype/icons');
const TILE = [0x32, 0x34, 0x37];   // monkeytype serika dark: bg
const KEY = [0xe2, 0xb7, 0x14];    // main
const THUMB = [0xd1, 0xd0, 0xc5];  // text

// Shapes in a 128-unit box: [x, y, w, h, radius, color]
const SHAPES = [[0, 0, 128, 128, 26, TILE]];
for (const [side, dir] of [[8, 1], [120, -1]]) {
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      const x = dir === 1 ? side + col * 16 : side - 13 - col * 16;
      const stagger = [4, 0, 3][col];
      SHAPES.push([x, 28 + row * 16 + stagger, 13, 13, 3, KEY]);
    }
  }
  const tx = dir === 1 ? side + 28 : side - 28 - 22;
  SHAPES.push([tx, 84, 22, 13, 3, THUMB]);
}

function inside(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function render(size) {
  const ss = 4; // supersampling for smooth edges
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = ((x + (sx + 0.5) / ss) / size) * 128, py = ((y + (sy + 0.5) / ss) / size) * 128;
          let color = null;
          for (const s of SHAPES) if (inside(px, py, s)) color = s[5];
          if (color) { r += color[0]; g += color[1]; b += color[2]; a++; }
        }
      }
      const i = (y * size + x) * 4;
      if (a) { rgba[i] = r / a; rgba[i + 1] = g / a; rgba[i + 2] = b / a; }
      rgba[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return png(size, rgba);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) writeFileSync(resolve(outDir, `icon-${size}.png`), render(size));
  console.log('icons ->', outDir);
}
