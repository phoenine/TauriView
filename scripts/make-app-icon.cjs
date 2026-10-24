/**
 * 生成应用图标源图 app-icon.png（1024×1024，扁平、满铺）。
 *
 * 为什么手写：项目里没有 sharp / Pillow / ImageMagick，
 * 而图标只是纯色块 + 一个书页形状，逐像素画反而没有依赖。
 *
 * 设计：整块圆角方底（强调色 #00ada2）+ 白色摊开书页，
 * 字形占画布约 74%，四周只留 ~7% —— 之前那版图标内部留白太多，
 * 任务栏里看起来比同排应用小一圈。
 *
 * 用法：node scripts/make-app-icon.cjs && npx @tauri-apps/cli icon app-icon.png
 */
const fs = require("node:fs");
const zlib = require("node:zlib");

const SIZE = 1024;
const SS = 2; // 2×2 超采样，边缘不至于锯齿
const W = SIZE * SS;

const BG = [0x00, 0xad, 0xa2]; // 强调色
const FG = [0xff, 0xff, 0xff];

/** 圆角矩形的内外判定（单位坐标 0..1，radius 也是 0..1） */
function inRoundRect(x, y, r) {
  const lx = Math.min(x, 1 - x);
  const ly = Math.min(y, 1 - y);
  if (lx >= r || ly >= r) return lx >= 0 && ly >= 0;
  const dx = r - lx;
  const dy = r - ly;
  return dx * dx + dy * dy <= r * r;
}

/** 多边形内外判定（射线法），pts 为 [[x,y], ...] 单位坐标 */
function inPoly(x, y, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// 摊开的书：左右两页在书脊处收窄，形成自然的翻页透视
const leftPage = [
  [0.492, 0.300],
  [0.160, 0.246],
  [0.160, 0.690],
  [0.492, 0.770],
];
const rightPage = [
  [0.508, 0.300],
  [0.840, 0.246],
  [0.840, 0.690],
  [0.508, 0.770],
];
const SPINE = 0.026; // 书脊缝宽（半宽）

const buf = Buffer.alloc(W * W * 3);
for (let py = 0; py < W; py++) {
  const y = (py + 0.5) / W;
  for (let px = 0; px < W; px++) {
    const x = (px + 0.5) / W;
    let rgb = null;
    if (inRoundRect(x, y, 0.22)) {
      const onPage = inPoly(x, y, leftPage) || inPoly(x, y, rightPage);
      const onSpine = Math.abs(x - 0.5) < SPINE && y > 0.3 && y < 0.75;
      rgb = onPage && !onSpine ? FG : BG;
    }
    const o = (py * W + px) * 3;
    if (rgb) {
      buf[o] = rgb[0];
      buf[o + 1] = rgb[1];
      buf[o + 2] = rgb[2];
    } else {
      // 圆角外：透明（alpha 另存）
      buf[o] = 0;
      buf[o + 1] = 0;
      buf[o + 2] = 0;
    }
  }
}

// 下采样到 SIZE，同时产出 alpha
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x * SS + sx;
        const py = y * SS + sy;
        const o = (py * W + px) * 3;
        const opaque = buf[o] !== 0 || buf[o + 1] !== 0 || buf[o + 2] !== 0;
        if (opaque) {
          r += buf[o];
          g += buf[o + 1];
          b += buf[o + 2];
          a += 255;
        }
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    const cover = a / (255 * n);
    if (cover > 0) {
      out[o] = Math.round(r / (n * cover));
      out[o + 1] = Math.round(g / (n * cover));
      out[o + 2] = Math.round(b / (n * cover));
    }
    out[o + 3] = Math.round(a / n);
  }
}

/* ---------- 最小 PNG 编码器（RGBA，filter 0） ---------- */
function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync("app-icon.png", png);
console.log("wrote app-icon.png", png.length, "bytes");
