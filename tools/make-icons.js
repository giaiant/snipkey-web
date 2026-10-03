'use strict';
// アイコンの PNG を作り直す（依存なし）。実行: node web/tools/make-icons.js
// 図柄は icons/icon.svg と同じ（緑の地に、3行のメモ）。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0x0b, 0x6e, 0x6e];
const PAPER = [0xff, 0xff, 0xff];
const INK = [0x0b, 0x6e, 0x6e];
const MARK = [0xf2, 0x8c, 0x28];

// 単位座標 [0,1] の角丸四角形の中にあるか
function inRoundRect(x, y, l, t, r, b, rad) {
  if (x < l || x > r || y < t || y > b) return false;
  const cx = Math.min(Math.max(x, l + rad), r - rad);
  const cy = Math.min(Math.max(y, t + rad), b - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}

// 上から順に塗る（後のものが上）
function layers(maskable) {
  return [
    { color: BG, test: (x, y) => (maskable ? true : inRoundRect(x, y, 0, 0, 1, 1, 0.22)) },
    { color: PAPER, test: (x, y) => inRoundRect(x, y, 0.27, 0.23, 0.73, 0.77, 0.06) },
    { color: INK, test: (x, y) => inRoundRect(x, y, 0.35, 0.34, 0.65, 0.40, 0.03) },
    { color: INK, test: (x, y) => inRoundRect(x, y, 0.35, 0.47, 0.60, 0.53, 0.03) },
    { color: MARK, test: (x, y) => inRoundRect(x, y, 0.35, 0.60, 0.50, 0.66, 0.03) },
  ];
}

function render(size, maskable) {
  const SS = 4; // 1画素を 4x4 で標本化して縁を滑らかにする
  const ls = layers(maskable);
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // 先頭は filter 種別 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let c = null;
          for (const l of ls) if (l.test(x, y)) c = l.color;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = 1 + px * 4;
      if (a) { row[o] = Math.round(r / a); row[o + 1] = Math.round(g / a); row[o + 2] = Math.round(b / a); }
      row[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  fs.writeFileSync(path.join(outDir, name), render(size, maskable));
  console.log('wrote', name);
}
