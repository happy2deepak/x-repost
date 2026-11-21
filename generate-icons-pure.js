#!/usr/bin/env node
// generate-icons-pure.js
// Generates icon-16.png, icon-48.png, icon-128.png using only Node.js built-ins.
// Uses raw PNG format (no external dependencies).

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// ─── Minimal PNG writer ──────────────────────────────────────────────────────
function writePng(width, height, pixels) {
  // pixels: Uint8Array of RGBA values, row by row

  function crc32(buf) {
    const table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const lenBuf    = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.allocUnsafe(4);
    const forCrc = Buffer.concat([typeBytes, data]);
    crcBuf.writeUInt32BE(crc32(forCrc), 0);
    return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 2;  // color type: RGB (we'll use 6=RGBA)
  ihdr[9]  = 6;
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT — filter byte (0) before each row + compress
  const raw = Buffer.allocUnsafe(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type None
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Draw icon ───────────────────────────────────────────────────────────────
// Violet rounded square with a white "media frame + outgoing arrow" glyph —
// the same glyph as the inline SVG used in the popup and on-page button
// (24×24 viewBox: rect 3,8 13×13 r3; arrow 10,14→20,4 with head at 13.5,4/20,10.5).
// Rendered with signed-distance functions and 4×4 supersampling for clean edges.
const BG = [124, 92, 255];   // #7c5cff
const FG = [255, 255, 255];

function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const SS = 4;
  // Glyph lives in a 24-unit box, inset so it breathes inside the tile.
  const pad = size * 0.16;
  const unit = (size - 2 * pad) / 24;
  const half = Math.max(size >= 48 ? 1.35 : 1.6, 0) * unit;   // stroke half-width (thicker at 16px)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0, fgCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          if (sdRoundRect(px, py, 0, 0, size, size, size * 0.22) > 0) continue;
          bgCov++;
          const gx = (px - pad) / unit, gy = (py - pad) / unit;
          const d = Math.min(
            Math.abs(sdRoundRect(gx, gy, 3, 8, 13, 13, 3)),
            sdSegment(gx, gy, 10, 14, 20, 4),
            sdSegment(gx, gy, 13.5, 4, 20, 4),
            sdSegment(gx, gy, 20, 4, 20, 10.5),
          ) * unit;
          if (d <= half) fgCov++;
        }
      }
      const n = SS * SS, a = bgCov / n, f = bgCov ? fgCov / bgCov : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return pixels;
}

// ─── Generate all sizes ───────────────────────────────────────────────────────
const SIZES = [16, 48, 128];

for (const size of SIZES) {
  const pixels = drawIcon(size);
  const png    = writePng(size, size, pixels);
  const out    = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✓  icons/icon-${size}.png (${png.length} bytes)`);
}

console.log('\nAll icons generated — no npm packages needed.');
