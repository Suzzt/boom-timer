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
const ctx = canvas.getContext('2d');

let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, MAXR = 1;
let cfg = PRESET.normal;
let opt = { shot: null, sound: true, volume: 0.7, fuse: true, text: '', intensity: 'normal' };
let hasShot = false;

const sparks = [];
const debris = [];
const smoke = [];
const embers = [];
let cracks = [];
let shockwaves = [];
let fireballs = [];

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
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = w;
  H = h;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  CX = W / 2;
  CY = H / 2;
  MAXR = Math.hypot(W, H) / 2;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- 音效（WebAudio 合成，无需音频文件）

let actx = null;

function audio() {
  if (!opt.sound) return null;
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

function noiseBuffer(ac, sec) {
  const len = Math.floor(ac.sampleRate * sec);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function playFuse(sec) {
  const ac = audio();
  if (!ac) return;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, sec + 0.1);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3400;
  bp.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.value = 0.05 * opt.volume;
  src.connect(bp).connect(g).connect(ac.destination);
  src.start();
  src.stop(ac.currentTime + sec);
}

function playBoom() {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const vol = opt.volume;
  const master = ac.createGain();
  master.gain.value = vol;
  master.connect(ac.destination);

  // 低频轰鸣
  const sub = ac.createOscillator();
  const subG = ac.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(150, now);
  sub.frequency.exponentialRampToValueAtTime(28, now + 0.75);
  subG.gain.setValueAtTime(0.0001, now);
  subG.gain.exponentialRampToValueAtTime(1.0, now + 0.012);
  subG.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
  sub.connect(subG).connect(master);
  sub.start(now);
  sub.stop(now + 1.1);

  // 爆裂主体（噪声 + 低通扫频）
  const body = ac.createBufferSource();
  body.buffer = noiseBuffer(ac, 1.6);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(5200, now);
  lp.frequency.exponentialRampToValueAtTime(120, now + 0.9);
  const bodyG = ac.createGain();
  bodyG.gain.setValueAtTime(0.0001, now);
  bodyG.gain.exponentialRampToValueAtTime(0.9, now + 0.006);
  bodyG.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
  body.connect(lp).connect(bodyG).connect(master);
  body.start(now);

  // 高频炸裂感
  const crack = ac.createBufferSource();
  crack.buffer = noiseBuffer(ac, 0.2);
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2200;
  const crackG = ac.createGain();
  crackG.gain.setValueAtTime(0.55, now);
  crackG.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  crack.connect(hp).connect(crackG).connect(master);
  crack.start(now);

  // 余震尾巴
  const tail = ac.createBufferSource();
  tail.buffer = noiseBuffer(ac, 2.0);
  const tlp = ac.createBiquadFilter();
  tlp.type = 'lowpass';
  tlp.frequency.value = 260;
  const tailG = ac.createGain();
  tailG.gain.setValueAtTime(0.35, now + 0.05);
  tailG.gain.exponentialRampToValueAtTime(0.0001, now + 1.9);
  tail.connect(tlp).connect(tailG).connect(master);
  tail.start(now + 0.05);
}

// ---------------------------------------------------------------- 粒子生成

function spawn() {
  const k = cfg.count;
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
    x: CX + Math.sin(u * 6.4 + 0.7) * R * 0.16 * Math.pow(1 - clamp01(u), 0.6),
    y: CY + Math.cos(u * 5.1) * R * 0.11 * Math.pow(1 - clamp01(u), 0.6),
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

function drawBomb(u) {
  // 残影：越近速度越快，拖影越明显
  const blur = 0.35 + u * 0.65;
  drawBombAt(Math.max(0, u - 0.055), 0.1 * blur);
  drawBombAt(Math.max(0, u - 0.025), 0.2 * blur);
  drawBombAt(u, 1);
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

function frame(now) {
  if (t0 < 0) t0 = now;
  const t = now - t0;
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;

  ctx.clearRect(0, 0, W, H);

  if (t < boomAt) {
    // ---- 引线阶段
    const u = clamp01(t / Math.max(1, boomAt));
    drawBomb(u);
    // 起爆前的紧张微抖
    const pre = u > 0.72 ? (u - 0.72) / 0.28 : 0;
    const k = pre * 6;
    stage.style.transform = `translate3d(${rand(-k, k)}px, ${rand(-k, k)}px, 0)`;
    requestAnimationFrame(frame);
    return;
  }

  const bt = (t - boomAt) / 1000;   // 爆炸后秒数

  // ---- 屏幕震动
  const sd = cfg.shake / 1000;
  if (bt < sd) {
    const u = bt / sd;
    const decay = Math.pow(1 - u, 2.2);
    const amp = cfg.amp * decay;
    const dx = (Math.sin(bt * 92) + Math.sin(bt * 143.7) * 0.6) * amp * rand(0.75, 1.15);
    const dy = (Math.cos(bt * 78.3) + Math.sin(bt * 121.1) * 0.6) * amp * rand(0.75, 1.15);
    const rot = Math.sin(bt * 61) * decay * (cfg.amp / 28) * 0.85;
    const cover = amp * 1.8 + Math.abs(rot) * (Math.PI / 180) * Math.max(W, H) * 0.5;
    const sc = 1 + (cover * 2) / Math.max(1, Math.min(W, H));
    stage.style.transform =
      `translate3d(${dx}px, ${dy}px, 0) rotate(${rot}deg) scale(${sc})`;
  } else {
    stage.style.transform = 'translate3d(0,0,0)';
  }

  // ---- 爆闪
  const flash = bt < 0.03 ? 1 : Math.max(0, 1 - (bt - 0.03) / 0.24);
  flashEl.style.opacity = String(flash * flash);

  // ---- 快照在震动结束后淡出，把真实桌面还给用户
  if (hasShot) {
    const fadeAt = sd + 0.12;
    shotEl.style.opacity = bt < fadeAt ? '1' : String(clamp01(1 - (bt - fadeAt) / 0.45));
  } else {
    const fadeAt = sd + 0.3;
    dimEl.style.opacity = bt < fadeAt
      ? String(clamp01(bt / 0.12) * 0.9)
      : String(clamp01(1 - (bt - fadeAt) / 0.6) * 0.9);
  }

  drawShockwave(bt);
  drawCracks(bt);
  drawFireball(bt);
  drawSmoke(dt);
  drawDebris(dt);
  drawSparks(dt);

  // ---- 文案
  if (bt > 0.22) {
    const u = clamp01((bt - 0.22) / 0.32);
    const out = bt > 1.9 ? clamp01(1 - (bt - 1.9) / 0.55) : 1;
    const s = 0.6 + easeOut(u) * 0.45 - (1 - out) * 0.1;
    msgEl.style.opacity = String(easeInOut(u) * out);
    msgEl.style.transform = `translateY(-50%) scale(${s})`;
  }

  if (bt * 1000 > TAIL_MS && sparks.length === 0 && smoke.length === 0) return done();
  if (bt * 1000 > TAIL_MS + 1200) return done();
  requestAnimationFrame(frame);
}

function done() {
  if (finished) return;
  finished = true;
  try { if (actx) actx.close(); } catch { /* ignore */ }
  window.api.boomDone();
}

// ---------------------------------------------------------------- 启动

window.api.onBoomInit((p) => {
  opt = { ...opt, ...p };
  cfg = PRESET[opt.intensity] || PRESET.normal;
  FUSE_MS = opt.fuse ? 900 : 0;
  boomAt = FUSE_MS;
  msgText.textContent = opt.text || '';

  hasShot = !!opt.shot;
  if (hasShot) {
    shotEl.src = opt.shot;
    shotEl.style.opacity = '1';
  }

  resize();
  spawn();

  if (FUSE_MS > 0) {
    playFuse(FUSE_MS / 1000);
    setTimeout(playBoom, FUSE_MS - 20);
  } else {
    playBoom();
  }
  requestAnimationFrame(frame);
});

window.api.boomReady();
setTimeout(() => { if (t0 < 0) done(); }, 4000);   // 兜底：没收到初始化就自杀
