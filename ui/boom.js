'use strict';

/* 爆炸浮层：引线 → 爆闪 → 冲击波 → 火球/火星/碎片/浓烟 → 屏幕震动 + 裂纹 → 提示文案 */

const PRESET = {
  gentle: { amp: 15, shake: 520, count: 0.6, radius: 0.85, cracks: 9 },
  normal: { amp: 28, shake: 720, count: 1.0, radius: 1.0, cracks: 13 },
  nuke:   { amp: 48, shake: 1000, count: 1.7, radius: 1.25, cracks: 18 },
};

const stage = document.getElementById('stage');
const shotEl = document.getElementById('shot');
const dimEl = document.getElementById('dim');
const flashEl = document.getElementById('flash');
const msgEl = document.getElementById('msg');
const msgText = document.getElementById('msg-text');
const canvas = document.getElementById('fx');
let ctx = canvas.getContext('2d');

let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, MAXR = 1;
let cfg = PRESET.normal;
let opt = { shot: null, sound: true, volume: 0.7, fuse: true, text: '', intensity: 'normal', primary: true };
let hasShot = false;

const sparks = [];
const debris = [];
const smoke = [];
const embers = [];
let cracks = [];
let shockwaves = [];
let fireballs = [];

// 飞入阶段的炸弹预渲染成精灵：原来每帧要重建约 24 个渐变对象，
// 而实测飞入阶段的顿挫率（27%）是引爆后（8%）的三倍多。
// 24 挡覆盖 0.9 秒，自转每挡只跳 6°，看不出来；按需构建，避免在起爆前一次性卡一下。
const BOMB_STEPS = 24;
const BOMB_PAD = 1.6;
const BOMB_SPRITE_MAX = 448;
let bombSprites = null;
let baking = false;

let FUSE_MS = 900;
const TAIL_MS = 2500;
let t0 = -1, boomAt = 0, finished = false;

// ---------------------------------------------------------------- helpers

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const easeOutQuint = (u) => 1 - Math.pow(1 - u, 5);
const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

function resize() {
  const r = stage.getBoundingClientRect();
  const w = Math.round(r.width) || window.innerWidth;
  const h = Math.round(r.height) || window.innerHeight;
  if (!w || !h) return;          // 尺寸异常时不要动画布，否则会清空已画好的内容
  // WKWebView 的填充率远不如 Chromium，画布像素要设上限。
  // 副屏再降一档：两个全屏浮层同时跑会互相抢 GPU。
  // 瓶颈不是我们的绘制（实测 0.86ms/帧），而是浏览器每帧把画布合成到
  // 全屏透明窗口的开销 —— 它随画布像素数增长。同机实测掉帧率：
  //   4.0MP → 26% | 3.0MP → 15% | 2.0MP → 11% | 1.6MP → 4% | 1.2MP → 2%
  // 取 1.6MP 拐点，对应 DPR≈0.89，比 1:1 只小一成，肉眼分辨不出。
  // 超采样对全是柔和渐变的爆炸没有收益，上限压到 1。
  const MAX_PX = window.__maxpx || (opt.primary ? 1.6e6 : 0.5e6);
  DPR = Math.min(window.devicePixelRatio || 1, 1, Math.sqrt(MAX_PX / Math.max(1, w * h)));
  W = w;
  H = h;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  CX = W / 2;
  CY = H / 2;
  MAXR = Math.hypot(W, H) / 2;
  bombSprites = null;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- 粒子生成

function spawn() {
  const k = cfg.count * (opt.primary ? 1 : 0.55);
  const base = Math.min(W, H);

  // 火星
  for (let i = 0; i < Math.round(220 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(0.15, 1.0) ** 1.7 * base * rand(1.6, 3.4);
    sparks.push({
      x: CX, y: CY, px: CX, py: CY,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.92,
      life: 0, max: rand(0.45, 1.35),
      w: rand(1.2, 3.4),
      hue: rand(12, 52),
    });
  }

  // 燃烧碎屑
  for (let i = 0; i < Math.round(46 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(0.25, 1) * base * rand(0.9, 2.1);
    debris.push({
      x: CX, y: CY,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(60, 260),
      rot: Math.random() * Math.PI, vr: rand(-9, 9),
      size: rand(3, 10), life: 0, max: rand(0.9, 1.9),
    });
  }

  // 缓慢上飘的火星（余烬）
  for (let i = 0; i < Math.round(60 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const r = rand(0, base * 0.22);
    embers.push({
      x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r,
      vx: rand(-40, 40), vy: rand(-150, -30),
      life: 0, max: rand(1.1, 2.3), size: rand(1.2, 3),
    });
  }

  // 浓烟
  for (let i = 0; i < Math.round(30 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(0.2, 1) * base * rand(0.5, 1.3);
    smoke.push({
      x: CX, y: CY,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(20, 90),
      r0: rand(base * 0.05, base * 0.13), grow: rand(1.6, 3.0),
      life: 0, max: rand(1.1, 2.2), tone: rand(48, 92),
    });
  }

  // 火球（多个团块叠加，避免「一个圆」的廉价感）
  fireballs = [];
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    fireballs.push({
      a, d: i === 0 ? 0 : rand(0.14, 0.52),
      r: (i === 0 ? 1 : rand(0.3, 0.72)) * MAXR * 0.5 * cfg.radius,
      delay: i === 0 ? 0 : rand(0, 0.09),
      speed: rand(0.85, 1.25),
    });
  }

  shockwaves = [
    { delay: 0, dur: 0.72, w: 26, alpha: 0.95, reach: 1.15 },
    { delay: 0.09, dur: 0.85, w: 10, alpha: 0.5, reach: 1.35 },
  ];

  cracks = makeCracks();
}

// 从中心放射的裂纹（带分叉），像屏幕被砸裂
function makeCracks() {
  const out = [];
  const n = cfg.cracks;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + rand(-0.16, 0.16);
    build(CX, CY, a0, MAXR * rand(0.55, 1.05), 0);
  }
  function build(x, y, angle, len, depth) {
    const pts = [{ x, y }];
    let cx = x, cy = y, ca = angle;
    const steps = Math.max(2, Math.round(len / rand(70, 140)));
    const seg = len / steps;
    for (let s = 0; s < steps; s++) {
      ca += rand(-0.16, 0.16);
      cx += Math.cos(ca) * seg;
      cy += Math.sin(ca) * seg;
      pts.push({ x: cx, y: cy });
      if (depth < 2 && Math.random() < 0.45 && s > 0) {
        build(cx, cy, ca + (Math.random() < 0.5 ? 1 : -1) * rand(0.35, 0.95), len * rand(0.22, 0.5), depth + 1);
      }
    }
    out.push({ pts, width: Math.max(0.6, 1.7 - depth * 0.55), depth });
  }
  return out;
}

// ---------------------------------------------------------------- 绘制

// 炸弹从屏幕正中央由远及近飞来：z 线性推近，半径按 1/z 变化 —— 天然的透视加速感
function bombGeom(u) {
  const Z_FAR = 7, Z_NEAR = 1;
  const z = Z_FAR + (Z_NEAR - Z_FAR) * Math.pow(clamp01(u), 0.85);
  const R = (Math.min(W, H) * 0.22) / z;
  return {
    R,
    x: CX + (baking ? 0 : Math.sin(u * 6.4 + 0.7) * R * 0.16 * Math.pow(1 - clamp01(u), 0.6)),
    y: CY + (baking ? 0 : Math.cos(u * 5.1) * R * 0.11 * Math.pow(1 - clamp01(u), 0.6)),
    rot: -0.85 + u * 2.5,
  };
}

// 定光源（左上）下的球体着色：本影 + 高光 + 边缘光 + 环境反弹光
function drawBombAt(u, alpha) {
  const { R, x, y, rot } = bombGeom(u);
  if (R < 0.5) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  // 与背景分离的暗halo
  const halo = ctx.createRadialGradient(x, y, R * 0.9, x, y, R * 1.55);
  halo.addColorStop(0, 'rgba(0,0,0,.38)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.55, 0, Math.PI * 2);
  ctx.fill();

  // 球体本色
  const body = ctx.createRadialGradient(x - R * 0.42, y - R * 0.46, R * 0.04, x, y, R * 1.04);
  body.addColorStop(0, '#9aa2b0');
  body.addColorStop(0.16, '#565d69');
  body.addColorStop(0.44, '#282c34');
  body.addColorStop(0.78, '#12141a');
  body.addColorStop(1, '#06070a');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();

  // 边缘加深，让球「鼓」出来
  const ao = ctx.createRadialGradient(x, y, R * 0.72, x, y, R);
  ao.addColorStop(0, 'rgba(0,0,0,0)');
  ao.addColorStop(1, 'rgba(0,0,0,.55)');
  ctx.fillStyle = ao;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';

  // 右下环境反弹光（暖色）
  const bounce = ctx.createRadialGradient(x + R * 0.5, y + R * 0.55, 0, x + R * 0.5, y + R * 0.55, R * 0.85);
  bounce.addColorStop(0, 'rgba(150,105,60,.5)');
  bounce.addColorStop(1, 'rgba(150,105,60,0)');
  ctx.fillStyle = bounce;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);

  // 引线火光从上方打下来的一点暖顶光
  const top = ctx.createRadialGradient(x + R * 0.15, y - R * 0.95, 0, x + R * 0.15, y - R * 0.95, R * 0.9);
  top.addColorStop(0, 'rgba(255,170,70,.45)');
  top.addColorStop(1, 'rgba(255,170,70,0)');
  ctx.fillStyle = top;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);

  // 主高光（柔）+ 芯高光（锐）
  const spec = ctx.createRadialGradient(x - R * 0.36, y - R * 0.42, 0, x - R * 0.36, y - R * 0.42, R * 0.42);
  spec.addColorStop(0, 'rgba(255,255,255,.85)');
  spec.addColorStop(0.45, 'rgba(255,255,255,.22)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);

  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath();
  ctx.ellipse(x - R * 0.38, y - R * 0.45, R * 0.12, R * 0.075, -0.6, 0, Math.PI * 2);
  ctx.fill();

  // 右下边缘光，勾出球体轮廓
  ctx.strokeStyle = 'rgba(185,200,228,.3)';
  ctx.lineWidth = Math.max(1, R * 0.035);
  ctx.beginPath();
  ctx.arc(x, y, R * 0.982, 0.02 * Math.PI, 0.6 * Math.PI);
  ctx.stroke();
  ctx.restore();

  // ---- 引信盖与引线（跟随炸弹自转）
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot * 0.35);

  const capW = R * 0.42, capH = R * 0.3, capY = -R * 1.02;
  const cap = ctx.createLinearGradient(-capW / 2, 0, capW / 2, 0);
  cap.addColorStop(0, '#20242b');
  cap.addColorStop(0.35, '#5c6470');
  cap.addColorStop(1, '#161a20');
  ctx.fillStyle = cap;
  ctx.beginPath();
  ctx.moveTo(-capW / 2, capY + capH);
  ctx.lineTo(-capW * 0.42, capY);
  ctx.lineTo(capW * 0.42, capY);
  ctx.lineTo(capW / 2, capY + capH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b7480';
  ctx.beginPath();
  ctx.ellipse(0, capY, capW * 0.42, capH * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();

  // 引线：越靠近火花越细
  const tipX = R * 0.62 + Math.sin(u * 17) * R * 0.05;
  const tipY = capY - R * 0.82;
  ctx.lineCap = 'round';
  for (const [w, col] of [[R * 0.13, '#4a3618'], [R * 0.075, '#a8804a']]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, w);
    ctx.beginPath();
    ctx.moveTo(0, capY - R * 0.02);
    ctx.quadraticCurveTo(R * 0.52, capY - R * 0.5, tipX, tipY);
    ctx.stroke();
  }

  // 火花
  ctx.globalCompositeOperation = 'lighter';
  const flick = 0.75 + Math.random() * 0.35;
  const sg = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, R * 0.95 * flick);
  sg.addColorStop(0, 'rgba(255,255,255,1)');
  sg.addColorStop(0.22, 'rgba(255,232,150,.95)');
  sg.addColorStop(0.5, 'rgba(255,150,40,.55)');
  sg.addColorStop(1, 'rgba(255,90,0,0)');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(tipX, tipY, R * 0.95 * flick, 0, Math.PI * 2);
  ctx.fill();

  const n = Math.max(3, Math.round(R * 0.12));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * R * 0.7;
    const sz = Math.max(1, R * 0.03 * Math.random());
    ctx.fillStyle = `rgba(255,${(190 + Math.random() * 65) | 0},90,${0.4 + Math.random() * 0.6})`;
    ctx.fillRect(tipX + Math.cos(a) * d, tipY + Math.sin(a) * d, sz, sz);
  }
  ctx.restore();
  ctx.restore();
}

// 把某一挡的炸弹（含三段残影）烘焙进一张小画布。
// 手法是临时把全局的 ctx / CX / CY 指到精灵画布上，直接复用 drawBombAt，
// 避免为了预渲染再写一份绘制逻辑。
function bakeBomb(idx) {
  const u = idx / (BOMB_STEPS - 1);
  const savedCtx = ctx, savedCX = CX, savedCY = CY;
  baking = true;
  const { R } = bombGeom(u);
  const want = Math.ceil(R * 2 * BOMB_PAD);
  const size = Math.max(8, Math.min(BOMB_SPRITE_MAX, want));
  const scale = size / Math.max(1, want);   // 超过上限时按比例缩小烘焙
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  CX = want / 2;
  CY = want / 2;
  const blur = 0.35 + u * 0.65;
  drawBombAt(Math.max(0, u - 0.055), 0.1 * blur);
  drawBombAt(Math.max(0, u - 0.025), 0.2 * blur);
  drawBombAt(u, 1);
  ctx = savedCtx;
  CX = savedCX;
  CY = savedCY;
  baking = false;
  return { canvas: c, half: want / 2 };
}

// 一次性把 24 挡全烘出来。绝不能等到动画跑起来再按需烘 ——
// 飞入阶段只有 30~40 帧，24 挡等于几乎每帧现烘一张，纯属净亏（实测顿挫 27%→33%）。
// 放在时间轴启动之前做，那时画面还是静止的，这一下卡顿看不见。
function bakeAllBombs() {
  bombSprites = new Array(BOMB_STEPS);
  for (let i = 0; i < BOMB_STEPS; i++) bombSprites[i] = bakeBomb(i);
}

function drawBomb(u) {
  if (!bombSprites) bakeAllBombs();
  let idx = Math.round(clamp01(u) * (BOMB_STEPS - 1));
  if (idx < 0) idx = 0;
  if (idx >= BOMB_STEPS) idx = BOMB_STEPS - 1;
  const sp = bombSprites[idx];

  // 位置和缩放仍然每帧连续计算，只有外观（自转、高光、火花）按挡取
  const { R, x, y } = bombGeom(u);
  if (R < 0.5) return;
  const { R: spR } = (() => {
    baking = true;
    const g = bombGeom(idx / (BOMB_STEPS - 1));
    baking = false;
    return g;
  })();
  const k = R / Math.max(0.001, spR);
  const half = sp.half * k;
  ctx.drawImage(sp.canvas, x - half, y - half, half * 2, half * 2);
}

function drawShockwave(bt) {
  for (const s of shockwaves) {
    const u = (bt - s.delay) / s.dur;
    if (u <= 0 || u >= 1) continue;
    const r = easeOutQuint(u) * MAXR * s.reach * cfg.radius;
    const a = (1 - u) * s.alpha;

    // 用桌面快照做一圈折射，冲击波才有「压过去」的实感
    if (hasShot && shotEl.complete && shotEl.naturalWidth) {
      const inner = Math.max(0, r - s.w * (1 - u) * 3);
      if (r > inner + 1) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, Math.PI * 2);
        ctx.arc(CX, CY, inner, 0, Math.PI * 2, true);
        ctx.clip();
        const k = 1 + 0.022 * (1 - u);
        ctx.globalAlpha = 0.55;
        ctx.drawImage(shotEl, CX - (W * k) / 2, CY - (H * k) / 2, W * k, H * k);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255,${200 - u * 90 | 0},${120 - u * 100 | 0},${a})`;
    ctx.lineWidth = Math.max(1, s.w * (1 - u) * cfg.radius);
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawFireball(bt) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const f of fireballs) {
    const u = (bt - f.delay) / (0.66 * f.speed);
    if (u <= 0 || u >= 1) continue;
    const grow = u < 0.28 ? easeOut(u / 0.28) : 1 + (u - 0.28) / 0.72 * 0.22;
    const r = f.r * grow;
    if (r <= 0) continue;
    const fade = u < 0.38 ? 1 : Math.pow(1 - (u - 0.38) / 0.62, 1.6);
    const dist = f.d * f.r * easeOut(Math.min(1, u * 1.6));
    const x = CX + Math.cos(f.a) * dist;
    const y = CY + Math.sin(f.a) * dist;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const core = clamp01(1 - u * 1.15);
    g.addColorStop(0, `rgba(255,255,${200 + core * 55 | 0},${0.98 * fade})`);
    g.addColorStop(0.22, `rgba(255,${215 - u * 60 | 0},${90 - u * 60 | 0},${0.92 * fade})`);
    g.addColorStop(0.55, `rgba(255,${120 - u * 60 | 0},20,${0.6 * fade})`);
    g.addColorStop(1, 'rgba(80,10,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSmoke(dt) {
  ctx.save();
  for (let i = smoke.length - 1; i >= 0; i--) {
    const p = smoke[i];
    p.life += dt;
    const u = p.life / p.max;
    if (u >= 1) { smoke.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.94; p.vy = p.vy * 0.94 - 34 * dt;
    const r = p.r0 * (1 + u * p.grow);
    const a = Math.sin(Math.min(1, u * 2.2) * Math.PI * 0.5) * Math.pow(1 - u, 1.3) * 0.62;
    // 早期被火球烤成暖色，后期转冷灰
    const warm = Math.max(0, 1 - u * 2.4);
    const tone = p.tone + u * 22;
    const cr = Math.min(255, tone + warm * 150);
    const cg = Math.min(255, tone * 0.94 + warm * 70);
    const cb = Math.min(255, tone * 0.9 + warm * 10);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},${a})`);
    g.addColorStop(0.65, `rgba(${(cr * 0.8) | 0},${(cg * 0.8) | 0},${(cb * 0.8) | 0},${a * 0.5})`);
    g.addColorStop(1, 'rgba(22,20,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSparks(dt) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.life += dt;
    const u = p.life / p.max;
    if (u >= 1) { sparks.splice(i, 1); continue; }
    p.px = p.x; p.py = p.y;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.955; p.vy = p.vy * 0.955 + 1150 * dt;
    const a = (1 - u) * (1 - u);
    ctx.strokeStyle = `hsla(${p.hue},100%,${54 + (1 - u) * 26}%,${a})`;
    ctx.lineWidth = p.w * (1 - u * 0.6);
    ctx.beginPath();
    ctx.moveTo(p.px, p.py);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  for (let i = embers.length - 1; i >= 0; i--) {
    const p = embers[i];
    p.life += dt;
    const u = p.life / p.max;
    if (u >= 1) { embers.splice(i, 1); continue; }
    p.x += (p.vx + Math.sin(p.life * 3 + p.size) * 30) * dt;
    p.y += p.vy * dt;
    p.vy *= 0.99;
    const a = (1 - u) * (0.6 + 0.4 * Math.sin(p.life * 18));
    ctx.fillStyle = `rgba(255,${140 + 80 * (1 - u) | 0},60,${a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDebris(dt) {
  ctx.save();
  for (let i = debris.length - 1; i >= 0; i--) {
    const p = debris[i];
    p.life += dt;
    const u = p.life / p.max;
    if (u >= 1) { debris.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.97; p.vy = p.vy * 0.97 + 1500 * dt;
    p.rot += p.vr * dt;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    const s = p.size * (1 - u * 0.25);
    ctx.fillStyle = `rgba(24,20,18,${1 - u})`;
    ctx.beginPath();
    ctx.moveTo(-s, -s * 0.6);
    ctx.lineTo(s * 0.8, -s);
    ctx.lineTo(s, s * 0.7);
    ctx.lineTo(-s * 0.7, s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(255,${110 + 60 * (1 - u) | 0},30,${(1 - u) * 0.8})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawCracks(bt) {
  const start = 0.045;
  if (bt < start) return;
  const grow = clamp01((bt - start) / 0.2);
  const fadeStart = 1.55;
  const alpha = bt < fadeStart ? 1 : clamp01(1 - (bt - fadeStart) / 0.75);
  if (alpha <= 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const c of cracks) {
    const total = c.pts.length - 1;
    const upto = Math.max(1, Math.round(total * grow));
    // 暗色描边（缝隙）
    ctx.strokeStyle = `rgba(0,0,0,${0.42 * alpha})`;
    ctx.lineWidth = c.width * 2.2;
    ctx.beginPath();
    ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i <= upto; i++) ctx.lineTo(c.pts[i].x, c.pts[i].y);
    ctx.stroke();
    // 亮边（玻璃反光）
    ctx.strokeStyle = `rgba(228,240,255,${0.6 * alpha})`;
    ctx.lineWidth = c.width;
    ctx.beginPath();
    ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i <= upto; i++) ctx.lineTo(c.pts[i].x, c.pts[i].y);
    ctx.stroke();
  }

  // 中心击碎点
  const r = Math.min(W, H) * 0.05;
  const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, r);
  g.addColorStop(0, `rgba(255,255,255,${0.35 * alpha})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(CX, CY, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- 主循环

let last = 0;
let lastDraw = 0;

function frame(now) {
  // 副屏主动降到 30fps：两块屏的全屏浮层同时全速跑会互抢 GPU，
  // 结果两边都卡。把预算让给用户正在看的主屏，副屏稳定 30fps
  // 反而比忽快忽慢的 60fps 观感更好。时间轴按真实时间算，跳帧不影响进度。
  const minFrame = opt.primary ? 0 : 32;
  if (minFrame && lastDraw && now - lastDraw < minFrame) {
    requestAnimationFrame(frame);
    return;
  }
  lastDraw = now;

  if (t0 < 0) t0 = now;
  const t = now - t0;
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;

  (window.__dt = window.__dt || []).push(dt * 1000);
  (t < boomAt ? (window.__dtFuse = window.__dtFuse || [])
              : (window.__dtBoom = window.__dtBoom || [])).push(dt * 1000);
  const __js0 = performance.now();

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (t < boomAt) {
    // ---- 炸弹飞来阶段：桌面还是那张静止的 DOM 图层（不动就不花合成开销）
    const u = clamp01(t / Math.max(1, boomAt));
    const pre = u > 0.72 ? (u - 0.72) / 0.28 : 0;
    const k = pre * 6;
    ctx.save();
    ctx.translate(Math.sin(t * 0.091) * k, Math.cos(t * 0.117) * k);
    drawBomb(u);
    ctx.restore();
    requestAnimationFrame(frame);
    return;
  }

  const bt = (t - boomAt) / 1000;   // 爆炸后秒数

  // ---- 屏幕震动（作用在画布变换上）
  const sd = cfg.shake / 1000;
  let dx = 0, dy = 0, rot = 0, sc = 1;
  if (bt < sd) {
    const u = bt / sd;
    const decay = Math.pow(1 - u, 2.2);
    const amp = cfg.amp * decay;
    // 三个不同频率的正弦叠加，既有爆炸该有的混乱感，运动又是连续可导的。
    // 原来这里乘了一个逐帧的 rand(0.75,1.15) —— 那是高频噪声，
    // 哪怕稳定 60fps 看着也像在掉帧，是「卡顿感」的一大来源。
    const nx = Math.sin(bt * 94.2) + 0.55 * Math.sin(bt * 151.7 + 1.3)
             + 0.26 * Math.sin(bt * 233.1 + 2.7);
    const ny = Math.cos(bt * 81.4) + 0.55 * Math.cos(bt * 139.3 + 0.7)
             + 0.26 * Math.cos(bt * 211.9 + 1.9);
    dx = nx * amp * 0.98;
    dy = ny * amp * 0.98;
    rot = (Math.sin(bt * 61) + 0.35 * Math.sin(bt * 107 + 0.9)) * decay * (cfg.amp / 28) * 0.68;
    const cover = amp * 1.8 + Math.abs(rot) * (Math.PI / 180) * Math.max(W, H) * 0.5;
    sc = 1 + (cover * 2) / Math.max(1, Math.min(W, H));
  }

  ctx.save();
  ctx.translate(CX + dx, CY + dy);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(sc, sc);
  ctx.translate(-CX, -CY);

  // ---- 桌面快照：震动结束后淡出，把真实桌面还给用户
  if (hasShot) {
    const fadeAt = sd + 0.12;
    const a = bt < fadeAt ? 1 : clamp01(1 - (bt - fadeAt) / 0.45);
    if (a > 0 && shotEl.complete && shotEl.naturalWidth) {
      ctx.globalAlpha = a;
      ctx.drawImage(shotEl, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  } else {
    // 没有快照时压暗背景，让震动和裂纹仍然「看得见」
    const fadeAt = sd + 0.3;
    const a = (bt < fadeAt ? clamp01(bt / 0.12) : clamp01(1 - (bt - fadeAt) / 0.6)) * 0.55;
    if (a > 0) {
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, MAXR);
      g.addColorStop(0, `rgba(0,0,0,${a * 0.2})`);
      g.addColorStop(1, `rgba(0,0,0,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(-W, -H, W * 3, H * 3);
    }
  }

  drawShockwave(bt);
  drawCracks(bt);
  drawFireball(bt);
  drawSmoke(dt);
  drawDebris(dt);
  drawSparks(dt);
  ctx.restore();

  // ---- 爆闪：同样画进画布，省掉一个全屏混合图层
  const flash = bt < 0.03 ? 1 : Math.max(0, 1 - (bt - 0.03) / 0.24);
  if (flash > 0.002) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${flash * flash})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---- 文案：同样画进画布。留在 DOM 里的话，这个全屏宽的图层每帧
  // 都要被合成器重新处理一遍，正是要消掉的那类开销。
  if (bt > 0.22) {
    const u = clamp01((bt - 0.22) / 0.32);
    const out = bt > 1.9 ? clamp01(1 - (bt - 1.9) / 0.55) : 1;
    const a = easeInOut(u) * out;
    if (a > 0.01) drawMessage(a, 0.6 + easeOut(u) * 0.45 - (1 - out) * 0.1, dx * 0.5, dy * 0.5);
  }

  window.__js = (window.__js || 0) + performance.now() - __js0;

  if (bt * 1000 > TAIL_MS && sparks.length === 0 && smoke.length === 0) return done();
  if (bt * 1000 > TAIL_MS + 1200) return done();
  requestAnimationFrame(frame);
}

// 帧时统计。BOOM_DEBUG=1 时写进日志 —— 这次把掉帧率从 26% 降到 8%
// 全靠它先证明「瓶颈不在 JS 绘制」，值得长期留着。
function phase(arr, med) {
  if (!arr || !arr.length) return 'n/a';
  const n = arr.filter((v) => v > med * 1.5).length;
  return `${arr.length}帧/顿挫${n}`;
}

function perfReport() {
  const d = (window.__dt || []).slice(1).sort((a, b) => a - b);
  if (!d.length) return;
  const q = (p) => d[Math.min(d.length - 1, Math.round(p * (d.length - 1)))].toFixed(1);
  // 阈值不能写死 20ms：显示器可能是 30Hz，或者系统开了低电量模式把刷新率压到 30Hz。
  // 以实测中位数为基准节奏，超过 1.5 倍才算真正的顿挫。
  const med = d[Math.floor(d.length / 2)];
  const jank = d.filter((v) => v > med * 1.5).length;
  window.api.log(
    `[perf] ${opt.primary ? '主屏' : '副屏'} 画布${canvas.width}x${canvas.height} ` +
    `节奏=${med.toFixed(1)}ms(≈${Math.round(1000 / med)}fps) ` +
    `p90=${q(0.9)} p99=${q(0.99)} 最大=${q(1)} 帧数=${d.length} ` +
    `顿挫(>1.5倍)=${jank}(${((jank / d.length) * 100).toFixed(0)}%) ` +
    `[飞入 ${phase(window.__dtFuse, med)} | 引爆后 ${phase(window.__dtBoom, med)}] ` +
    `JS绘制=${((window.__js || 0) / d.length).toFixed(2)}ms/帧 预烘=${(window.__bake || 0).toFixed(0)}ms`
  );
}

// 文案预渲染成一张精灵图：带发光的文字每帧重画一次要 ~10ms（canvas 的
// shadowBlur 极贵），预渲染后每帧只剩一次 drawImage。
let msgSprite = null;

function buildMsgSprite() {
  const base = Math.min(W, H);
  const sw = W;
  const sh = base * 0.44;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * DPR));
  c.height = Math.max(1, Math.round(sh * DPR));
  const g = c.getContext('2d');
  g.scale(DPR, DPR);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  g.shadowColor = 'rgba(255,140,20,.95)';
  g.shadowBlur = base * 0.036;
  g.font = `${base * 0.128}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  g.fillText('💥', sw / 2, sh * 0.32);

  g.shadowColor = 'rgba(255,110,20,.95)';
  g.shadowBlur = base * 0.025;
  g.fillStyle = '#fff';
  g.font = `800 ${base * 0.056}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  g.fillText(opt.text || '', sw / 2, sh * 0.68);

  msgSprite = { canvas: c, w: sw, h: sh };
}

function drawMessage(alpha, scale, dx, dy) {
  if (!msgSprite) buildMsgSprite();
  const { canvas: sp, w, h } = msgSprite;
  const dw = w * scale;
  const dh = h * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(sp, CX + dx - dw / 2, CY + dy - dh / 2, dw, dh);
  ctx.restore();
}

function done() {
  if (finished) return;
  finished = true;
  perfReport();
  // 留一点时间让上面那条日志的 IPC 落地。直接销毁窗口的话，
  // release 版够快，日志会在半路丢掉。浮层此时已经完全淡出，看不出差别。
  setTimeout(() => window.api.boomDone(), 50);
}

// ---------------------------------------------------------------- 启动

window.api.onBoomInit(async (p) => {
  opt = { ...opt, ...p };
  cfg = PRESET[opt.intensity] || PRESET.normal;
  FUSE_MS = opt.fuse ? 900 : 0;
  boomAt = FUSE_MS;
  msgText.textContent = opt.text || '';

  resize();

  // 关键：整屏截图有 1~2MB，解码和 GPU 上传要几百毫秒。
  // 不先做掉的话，这笔开销正好砸在炸弹飞来和爆炸的头一秒上，帧率从 60 掉到 20。
  // 截图是异步送达的（抓屏 0.4 秒，放在动画开跑之后做）。
  // 飞入阶段浮层保持全透明 —— 用户看到的是自己的真实桌面，比冻结的截图更自然；
  // 到引爆那一刻才切成画布里的截图，内容跳变被爆闪盖住。
  hasShot = false;
  window.api.onBoomShot(async (src) => {
    // 已经炸开之后才送到就不要了，中途切进来会看着像跳帧
    if (t0 >= 0 && performance.now() - t0 >= boomAt) return;
    shotEl.src = src;
    try {
      await (shotEl.decode ? shotEl.decode() : Promise.resolve());
      ctx.drawImage(shotEl, 0, 0, 1, 1);   // 提前把纹理推上 GPU
      ctx.clearRect(0, 0, 2, 2);
      hasShot = true;
    } catch { /* 解码失败就维持降级效果 */ }
  });

  spawn();

  // 预烘炸弹精灵并记录耗时，确认这一下没有拖慢首帧
  const tb = performance.now();
  bakeAllBombs();
  window.__bake = performance.now() - tb;

  if (opt.sound) {
    if (FUSE_MS > 0) {
      window.api.playSound('fuse', opt.volume, FUSE_MS / 1000);
      setTimeout(() => window.api.playSound('boom', opt.volume), FUSE_MS - 20);
    } else {
      window.api.playSound('boom', opt.volume);
    }
  }
  requestAnimationFrame(frame);
});

window.api.boomReady();
setTimeout(() => { if (t0 < 0) done(); }, 4000);   // 兜底：没收到初始化就自杀
