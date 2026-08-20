'use strict';

/* 生成 build/icon.png（512×512）—— electron-builder 会据此自动产出 .icns / .ico */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const SS = 3;                      // 超采样倍数（抗锯齿）
const N = S * SS;

const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const len = (x, y) => Math.hypot(x, y);

function roundedBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// 引线：二次贝塞尔，取到曲线的近似距离
const FUSE = { p0: [0.46, 0.345], p1: [0.70, 0.215], p2: [0.655, 0.105] };
function fuseDist(x, y) {
  let best = 1e9;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, it = 1 - t;
    const bx = it * it * FUSE.p0[0] + 2 * it * t * FUSE.p1[0] + t * t * FUSE.p2[0];
    const by = it * it * FUSE.p0[1] + 2 * it * t * FUSE.p1[1] + t * t * FUSE.p2[1];
    best = Math.min(best, len(x - bx, y - by));
  }
  return best;
}

function shade(x, y) {
  // x, y ∈ [0,1]
  const d = roundedBox(x - 0.5, y - 0.5, 0.5, 0.5, 0.225);
  const a = Math.max(0, Math.min(1, -d * N * 0.5 + 0.5));
  if (a <= 0) return [0, 0, 0, 0];

  // 底：深色渐变
  let r = mix(38, 18, y), g = mix(30, 17, y), b = mix(24, 20, y);

  // 爆炸辉光
  const glow = Math.max(0, 1 - len(x - 0.62, y - 0.20) / 0.55);
  r += 210 * glow ** 2.2; g += 110 * glow ** 2.6; b += 20 * glow ** 3.4;

  // 炸弹球体
  const bx = x - 0.46, by = y - 0.615, R = 0.285;
  const dist = len(bx, by);
  if (dist < R + 0.004) {
    const k = Math.max(0, Math.min(1, (R - dist) / 0.006));
    const nx = bx / R, ny = by / R;
    const lit = Math.max(0, 1 - len(nx + 0.42, ny + 0.45) / 1.15);
    const rim = Math.max(0, 1 - Math.abs(dist - R) / 0.05) * Math.max(0, ny * 0.5 + 0.4);
    const bodyR = mix(14, 118, lit ** 2.4) + rim * 90;
    const bodyG = mix(15, 124, lit ** 2.4) + rim * 55;
    const bodyB = mix(19, 136, lit ** 2.4) + rim * 20;
    r = mix(r, bodyR, k); g = mix(g, bodyG, k); b = mix(b, bodyB, k);
  }

  // 引信盖
  if (Math.abs(x - 0.46) < 0.052 && y > 0.30 && y < 0.355) {
    const t = (y - 0.30) / 0.055;
    r = mix(58, 34, t); g = mix(62, 37, t); b = mix(70, 43, t);
  }

  // 引线
  const fd = fuseDist(x, y);
  if (fd < 0.02) {
    const k = Math.max(0, Math.min(1, (0.017 - fd) / 0.005));
    r = mix(r, 150, k); g = mix(g, 112, k); b = mix(b, 62, k);
  }

  // 火花
  const sd = len(x - FUSE.p2[0], y - FUSE.p2[1]);
  const spark = Math.max(0, 1 - sd / 0.14);
  r += 255 * spark ** 1.6; g += 220 * spark ** 2.0; b += 120 * spark ** 3.0;

  return [Math.min(255, r), Math.min(255, g), Math.min(255, b), a * 255];
}

// ---- 渲染 + 超采样

const raw = Buffer.alloc(S * (S * 4 + 1));
let o = 0;
for (let py = 0; py < S; py++) {
  raw[o++] = 0;                                   // filter type: none
  for (let px = 0; px < S; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade((px + (sx + 0.5) / SS) / S, (py + (sy + 0.5) / SS) / S);
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
    }
    const n = SS * SS;
    raw[o++] = a > 0 ? Math.round(r / a) : 0;
    raw[o++] = a > 0 ? Math.round(g / a) : 0;
    raw[o++] = a > 0 ? Math.round(b / a) : 0;
    raw[o++] = Math.round(a / n);
  }
}

// ---- 最小 PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('图标已生成:', out, (png.length / 1024).toFixed(1) + ' KB');
