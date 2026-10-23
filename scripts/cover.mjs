// Generates cover.png (800x534) for gladys-inexogy: plain Node, no dependency.
// A smart electricity meter with its digital display, linked to a cloud with
// a consumption curve, and a gas meter dial (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W) * 0.5 + (y / H) * 0.5;
    set(x, y, [20 + 30 * t, 110 - 40 * t, 120 + 40 * t]);
  }
}
const white = [255, 255, 255];
const dark = [24, 34, 52];
const screen = [150, 230, 170];
const amber = [255, 190, 60];
const grey = [210, 215, 225];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);

// The smart electricity meter: a case, its display with digits, an optical port.
box(70, 120, 330, 440, 22, white);
box(95, 150, 305, 230, 10, dark);
box(105, 160, 295, 220, 6, screen, 0.9);
for (let k = 0; k < 6; k += 1) {
  const x = 115 + k * 29;
  box(x, 170, x + 20, 210, 3, dark, 0.75);
}
disc(150, 300, 34, dark);
disc(150, 300, 22, grey);
disc(150, 300, 8, dark);
box(110, 370, 290, 410, 8, grey);
disc(130, 390, 7, amber);
// The lightning bolt.
line(245, 252, 222, 300, 9, amber);
line(222, 300, 252, 300, 9, amber);
line(252, 300, 228, 350, 9, amber);

// The link up to the cloud.
line(330, 280, 420, 280, 6, white);
line(420, 280, 470, 230, 6, white);

// The cloud with a consumption curve.
disc(500, 170, 62, white);
disc(575, 140, 78, white);
disc(660, 172, 60, white);
box(470, 170, 710, 238, 28, white);
let previous;
for (let x = 495; x <= 685; x += 2) {
  const t = (x - 495) / 190;
  const y = 215 - 40 * Math.abs(Math.sin(3 * Math.PI * t)) - 15 * t;
  if (previous) line(previous[0], previous[1], x, y, 6, [40, 150, 120]);
  previous = [x, y];
}

// A gas meter with its dial, linked to the cloud too.
line(600, 238, 600, 330, 6, white);
box(530, 330, 680, 470, 18, white);
box(552, 352, 658, 392, 6, dark);
for (let k = 0; k < 4; k += 1) {
  const x = 560 + k * 24;
  box(x, 360, x + 18, 384, 3, grey);
}
disc(605, 430, 22, grey);
line(605, 430, 620, 418, 5, dark);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
