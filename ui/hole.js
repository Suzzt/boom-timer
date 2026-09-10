'use strict';

/* 黑洞吸屏：整块屏幕碎成方块被螺旋吸进黑洞，之后必须点一下才复原。

   与爆炸模式的关键差别是这个浮层会「吃掉点击」。所以点击捕获不是一上来就开，
   而是等复原处理器挂好之后才由前端主动向 Rust 申请（hole_armed）——
   万一前端出错，浮层就还是穿透的，绝不会把用户锁在屏幕外面。 */

(() => {
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('hole');
  const ctx = canvas.getContext('2d');
  const shotEl = document.getElementById('shot');

  // 时间轴（毫秒）
  const FORM_MS = 700;      // 黑洞成形，浮层仍透明，透出实时桌面
  const SUCK_SPREAD = 560;  // 越靠外的碎块出发越晚
  const SUCK_TRAVEL = 850;  // 单块从原位到被吞掉的时长
  const RESTORE_MS = 380;   // 点击后弹回

  let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, MAXR = 1;
  let opt = { sound: true, volume: 0.7, primary: true, text: '', shotPending: false };
  let running = false;
  let t0 = -1;
  let phase = 'form';       // form → suck → void → restore → done
  let restoreAt = 0;
  let suckAt = FORM_MS;
  let hasShot = false;
  let tiles = null;
  // 截图按画布分辨率预缩一份。直接拿 3584×2240 的原图切块的话，
  // 每帧 126 次「大图取小块再缩小」的重采样，吸入阶段直接掉到 25fps。
  let shotScaled = null;
  let wisps = [];
  let promptSprite = null;
  let lastDraw = 0;
  let lastVoid = -1;
  // 吸入阶段撑不住 60fps 时主动锁 30 —— 稳定的 30 比在 17 和 33 之间来回抖好看得多。
  // 先放 10 帧自由跑做采样，再据此决定。
  let pace = 0;
  let paceLocked = false;
  let paceSamples = [];
  let armed = false;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  const easeIn = (u) => u * u * u;
  const rand = (a, b) => a + Math.random() * (b - a);
  const dlog = (m) => { try { window.api.log(`[hole] ${m}`); } catch { /* 无所谓 */ } };

  function resize() {
    const r = stage.getBoundingClientRect();
    const w = Math.round(r.width) || window.innerWidth;
    const h = Math.round(r.height) || window.innerHeight;
    if (!w || !h) return;
    // 与爆炸模式同样的结论：瓶颈是每帧把画布合成到全屏窗口，开销随画布像素数增长
    const MAX_PX = window.__maxpx || (opt.primary ? 1.6e6 : 0.5e6);
    DPR = Math.min(window.devicePixelRatio || 1, 1, Math.sqrt(MAX_PX / Math.max(1, w * h)));
    W = w; H = h;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W / 2; CY = H / 2;
    MAXR = Math.hypot(W, H) / 2;
    promptSprite = null;
    tiles = null;
    shotScaled = null;
  }

  // ---------------------------------------------------------------- 碎块

  function buildShotScaled() {
    if (!shotEl.naturalWidth) return;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * DPR));
    c.height = Math.max(1, Math.round(H * DPR));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(shotEl, 0, 0, c.width, c.height);
    shotScaled = c;
  }

  function buildTiles() {
    if (!shotEl.naturalWidth) return;
    if (!shotScaled) buildShotScaled();
    // 碎块数直接决定吸入阶段的帧时：126 块 ≈ +14ms/帧，54 块 ≈ +4ms。
    // 9 列在「碎成一片片」的观感和帧率之间取平衡。
    const cols = window.__holeCols || 9;
    const rows = Math.max(6, Math.round(cols * H / W));
    const tw = W / cols;
    const th = H / rows;
    // 源尺寸按预缩图算，取块与落块基本 1:1，重采样成本最低
    const sw = shotScaled.width / cols;
    const sh = shotScaled.height / rows;
    tiles = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = (cx + 0.5) * tw;
        const y = (cy + 0.5) * th;
        const dx = x - CX;
        const dy = y - CY;
        const r0 = Math.hypot(dx, dy);
        tiles.push({
          sx: cx * sw, sy: cy * sh, sw, sh,
          tw, th,
          r0,
          a0: Math.atan2(dy, dx),
          // 靠中心的先被吞，外圈依次跟上；加点抖动，免得像一圈一圈整齐塌陷
          delay: (r0 / MAXR) * SUCK_SPREAD * rand(0.82, 1.18) / 1000,
          spin: rand(-3.4, 3.4),
          swirl: rand(2.2, 3.4),
        });
      }
    }
  }

  function spawnWisps() {
    wisps = [];
    for (let i = 0; i < 130; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.18, 1.05) * MAXR;
      wisps.push({
        a, r,
        r0: r,
        v: rand(0.55, 1.5),
        w: rand(0.8, 2.6),
        hue: rand(18, 44),
        life: rand(0.3, 1),
      });
    }
  }

  // ---------------------------------------------------------------- 黑洞本体

  function holeRadius(t) {
    const base = Math.min(W, H);
    if (phase === 'form') return base * 0.062 * easeOut(clamp01(t / FORM_MS));
    if (phase === 'restore') {
      const q = clamp01((t - restoreAt) / RESTORE_MS);
      return base * 0.092 * (1 - easeIn(q));
    }
    return base * (0.062 + 0.03 * clamp01((t - FORM_MS) / 900));
  }

  function drawHole(t, Rh) {
    if (Rh < 0.5) return;
    const spin = t / 1000;

    // 引力井：周围一圈渐暗
    // 半径直接决定填充面积，而面积是这里最贵的东西。3.3 倍够用，
    // 5.5 倍的话光这一个渐变每帧就要多吃好几毫秒。
    const wellR = Rh * 3.3;
    const well = ctx.createRadialGradient(CX, CY, Rh * 0.9, CX, CY, wellR);
    well.addColorStop(0, 'rgba(0,0,0,.94)');
    well.addColorStop(0.4, 'rgba(0,0,0,.5)');
    well.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = well;
    ctx.beginPath();
    ctx.arc(CX, CY, wellR, 0, Math.PI * 2);
    ctx.fill();

    // 吸积盘：压扁的椭圆，内圈白热、外圈橙红，绕轴缓慢旋转
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(CX, CY);
    ctx.rotate(Math.sin(spin * 0.35) * 0.12 - 0.18);
    for (let i = 0; i < 3; i++) {
      const rx = Rh * (1.5 + i * 0.62);
      const ry = rx * 0.3;
      const g = ctx.createLinearGradient(-rx, 0, rx, 0);
      const a = 0.5 - i * 0.13;
      g.addColorStop(0, `rgba(255,${150 - i * 30},${40 - i * 10},0)`);
      g.addColorStop(0.28, `rgba(255,${205 - i * 30},${120 - i * 30},${a})`);
      g.addColorStop(0.5, `rgba(255,255,${235 - i * 40},${a * 1.25})`);
      g.addColorStop(0.72, `rgba(255,${205 - i * 30},${120 - i * 30},${a})`);
      g.addColorStop(1, `rgba(255,${150 - i * 30},${40 - i * 10},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 事件视界：纯黑，压在吸积盘上
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(CX, CY, Rh, 0, Math.PI * 2);
    ctx.fill();

    // 光子环
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const ring = ctx.createRadialGradient(CX, CY, Rh * 0.98, CX, CY, Rh * 1.42);
    ring.addColorStop(0, 'rgba(255,244,220,0)');
    ring.addColorStop(0.22, 'rgba(255,238,205,.95)');
    ring.addColorStop(0.5, 'rgba(255,176,90,.42)');
    ring.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(CX, CY, Rh * 1.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 原本这里做的是引力透镜：把截图在环带里裁剪放大重绘。视觉上很对，
  // 但实测每帧要 15ms（CPU 只报 0.04ms，成本全在 GPU 的裁剪 + 全图重采样上），
  // 吸入阶段直接从 60fps 掉到 25fps。改成一圈暖色光晕近似，几乎零成本。
  function drawLensing(Rh, alpha) {
    if (alpha <= 0.01 || Rh < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(CX, CY, Rh * 1.05, CX, CY, Rh * 3.1);
    g.addColorStop(0, `rgba(255,214,160,${0.3 * alpha})`);
    g.addColorStop(0.35, `rgba(255,150,80,${0.14 * alpha})`);
    g.addColorStop(1, 'rgba(120,60,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(CX, CY, Rh * 3.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawWisps(dt, Rh, alpha) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of wisps) {
      p.a += (0.9 + 1.8 * (1 - p.r / MAXR)) * p.v * dt;
      p.r -= (60 + 520 * (1 - p.r / MAXR)) * p.v * dt;
      if (p.r < Rh * 0.9) { p.r = rand(0.7, 1.1) * MAXR; p.a = Math.random() * Math.PI * 2; }
      const x = CX + Math.cos(p.a) * p.r;
      const y = CY + Math.sin(p.a) * p.r;
      const tail = 0.16 * (1 - p.r / MAXR) + 0.04;
      const x2 = CX + Math.cos(p.a - tail) * (p.r + 26);
      const y2 = CY + Math.sin(p.a - tail) * (p.r + 26);
      ctx.strokeStyle = `hsla(${p.hue},100%,68%,${p.life * alpha * (1 - p.r / MAXR) * 0.9})`;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 碎块吸入 / 弹回

  // p=0 在原位，p=1 已被吞。原位时正好拼回完整画面，所以不需要额外画整图。
  function drawTiles(tt, reverse) {
    if (!tiles || !shotScaled) return 0;
    let alive = 0;
    let curAlpha = 1;
    ctx.globalAlpha = 1;
    for (const tile of tiles) {
      let p;
      if (reverse) {
        // 弹回：内圈先到位，整体在 RESTORE_MS 内收完
        const lead = (tile.r0 / MAXR) * 0.28;
        p = 1 - clamp01((tt - lead * RESTORE_MS / 1000) / (RESTORE_MS / 1000 * 0.85));
        p = clamp01(p);
        p = 1 - easeOut(1 - p);
      } else {
        p = clamp01((tt - tile.delay) / (SUCK_TRAVEL / 1000));
      }
      if (p >= 1) continue;
      alive++;

      const e = easeIn(p);
      const r = tile.r0 * (1 - e);
      const a = tile.a0 + tile.swirl * e * (1 + 0.7 * (1 - tile.r0 / MAXR));
      const k = Math.max(0.05, Math.pow(Math.max(0.001, r / Math.max(1, tile.r0)), 0.72));
      const px = CX + Math.cos(a) * r;
      const py = CY + Math.sin(a) * r;
      const al = p < 0.72 ? 1 : 1 - (p - 0.72) / 0.28;

      // 用 setTransform 直接写矩阵，省掉每块一对 save/restore；
      // alpha 只在真正需要淡出时才改，减少状态切换。
      const rot = a + tile.spin * e;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      // 沿半径方向拉长、切向压扁 —— 越靠近黑洞被抻得越细长
      const kr = k * (1 + 1.15 * p);
      const kt = k * (1 - 0.4 * p);
      ctx.setTransform(
        DPR * kr * cos, DPR * kr * sin,
        DPR * -kt * sin, DPR * kt * cos,
        DPR * px, DPR * py
      );
      if (al !== curAlpha) { ctx.globalAlpha = al; curAlpha = al; }
      ctx.drawImage(shotScaled, tile.sx, tile.sy, tile.sw, tile.sh,
        -tile.tw / 2, -tile.th / 2, tile.tw, tile.th);
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalAlpha = 1;
    return alive;
  }

  // ---------------------------------------------------------------- 提示文案

  function buildPrompt() {
    const base = Math.min(W, H);
    const sw = W;
    const sh = base * 0.3;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * DPR));
    c.height = Math.max(1, Math.round(sh * DPR));
    const g = c.getContext('2d');
    g.scale(DPR, DPR);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(140,190,255,.7)';
    g.shadowBlur = base * 0.02;
    g.fillStyle = '#fff';
    g.font = `700 ${base * 0.046}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    g.fillText('点击任意位置恢复', sw / 2, sh * 0.36);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(190,205,230,.72)';
    g.font = `500 ${base * 0.024}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    g.fillText(opt.text || '起来动一动', sw / 2, sh * 0.68);
    promptSprite = { canvas: c, w: sw, h: sh };
  }

  function drawPrompt(alpha) {
    if (alpha <= 0.01) return;
    if (!promptSprite) buildPrompt();
    const { canvas: sp, w, h } = promptSprite;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(sp, CX - w / 2, CY + Math.min(W, H) * 0.17, w, h);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 主循环

  let last = 0;

  function frame(now) {
    if (t0 < 0) t0 = now;
    const t = now - t0;

    // 待命阶段画面几乎不动，降到 30fps，别让一个常驻全屏窗口一直烧 GPU
    const minFrame = phase === 'void' ? 32 : pace;
    if (minFrame && lastDraw && now - lastDraw < minFrame) {
      requestAnimationFrame(frame);
      return;
    }
    lastDraw = now;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    (window.__dt = window.__dt || []).push(dt * 1000);
    if (phase === 'suck') {
      (window.__dtSuck = window.__dtSuck || []).push(dt * 1000);
      if (!paceLocked) {
        paceSamples.push(dt * 1000);
        // 第 10 帧先判一次；没锁的话第 24 帧再判一次 ——
        // 碎块越往里走越密，开头撑得住不代表后面撑得住
        const n = paceSamples.length;
        if (n === 10 || n === 24) {
          const sorted = paceSamples.slice(-10).sort((a, b) => a - b);
          const med = sorted[sorted.length >> 1];
          if (med > 21) {
            pace = 32;
            paceLocked = true;
            dlog(`吸入采样中位 ${med.toFixed(1)}ms → 锁 30fps`);
          } else if (n === 24) {
            paceLocked = true;
            dlog(`吸入采样中位 ${med.toFixed(1)}ms → 保持 60fps`);
          }
        }
      }
    }

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 碎块散完之后要有实底，否则透出的还是实时桌面，「被吸走」就不成立了
    let voidness = 0;
    if (phase === 'suck' || phase === 'void') {
      voidness = clamp01((t - suckAt - SUCK_SPREAD * 0.6) / 700);
    } else if (phase === 'restore') {
      voidness = 1 - clamp01((t - restoreAt) / (RESTORE_MS * 0.8));
    }
    // 「碎块散完后要有实底」用画布元素自身的背景色来做，而不是每帧 fillRect。
    // 纯色层由合成器处理，成本可以忽略；每帧多一次全屏填充则要 10ms 以上。
    if (voidness !== lastVoid) {
      lastVoid = voidness;
      canvas.style.background = voidness > 0.004
        // 要给到全不透明：留 1.6% 的话桌面内容会淡淡透出来，「被吸走」就露馅了
        ? `rgba(5,6,10,${Math.min(1, voidness * 1.06).toFixed(3)})`
        : 'transparent';
    }

    const Rh = holeRadius(t);

    if (phase === 'form') {
      drawWisps(dt, Rh, clamp01(t / 300));
      drawHole(t, Rh);
      // 抓屏 + 解码大约 0.6~0.9 秒，比成形阶段长。没等到就先让黑洞多转一会儿，
      // 否则吸入阶段头一两百毫秒没有碎块，画面会先空一下再突然冒出来。
      const waitedEnough = t >= FORM_MS && (hasShot || !opt.shotPending || t >= FORM_MS + 700);
      if (waitedEnough) {
        phase = 'suck';
        suckAt = t;
        if (hasShot && !tiles) buildTiles();
        dlog(`进入吸入阶段 t=${t | 0} 有截图=${hasShot}`);
      }
    } else if (phase === 'suck') {
      if (hasShot && !tiles) buildTiles();
      const tt = (t - suckAt) / 1000;
      const alive = drawTiles(tt, false);
      drawLensing(Rh, clamp01(1 - tt / 0.9) * 0.85);
      drawWisps(dt, Rh, 1);
      drawHole(t, Rh);
      const timeUp = tt > (SUCK_SPREAD + SUCK_TRAVEL) / 1000 + 0.25;
      if ((tiles && alive === 0) || timeUp) {
        phase = 'void';
        arm();
        dlog(`进入待命阶段 t=${t | 0}`);
      }
    } else if (phase === 'void') {
      drawWisps(dt, Rh, 0.5);
      drawHole(t, Rh);
      drawPrompt(0.72 + 0.28 * Math.sin(t / 380));
    } else if (phase === 'restore') {
      const q = clamp01((t - restoreAt) / RESTORE_MS);
      drawTiles((t - restoreAt) / 1000, true);
      drawHole(t, Rh);
      // 收束成一点时闪一下，复位才有「啪」的干脆感
      const flash = Math.max(0, 1 - Math.abs(q - 0.72) / 0.16) * 0.5;
      if (flash > 0.004) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(200,225,255,${flash})`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      if (q >= 1) return done();
    }

    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 收尾与输入

  function arm() {
    if (armed) return;
    armed = true;
    window.api.holeArmed();
  }

  function requestRestore(src) {
    if (phase === 'restore' || phase === 'done' || !running) return;
    dlog(`收到复原请求 来源=${src}`);
    window.api.holeDismiss();     // 广播，多屏一起复原
  }

  function beginRestore() {
    if (phase === 'restore' || phase === 'done' || !running) return;
    if (!tiles && hasShot) buildTiles();
    phase = 'restore';
    restoreAt = performance.now() - t0;
    if (opt.sound) window.api.playSound('restore', opt.volume);
  }

  function done() {
    if (phase === 'done') return;
    phase = 'done';
    running = false;
    canvas.style.display = 'none';
    canvas.style.background = 'transparent';
    const d = (window.__dt || []).slice(1).sort((a, b) => a - b);
    if (d.length) {
      const med = d[Math.floor(d.length / 2)];
      const jank = d.filter((v) => v > med * 1.5).length;
      const sk = (window.__dtSuck || []).slice().sort((a, b) => a - b);
      const skMed = sk.length ? sk[Math.floor(sk.length / 2)] : 0;
      const skJank = sk.filter((v) => v > skMed * 1.5).length;   // 阈值跟着实测节奏走，不写死
      dlog(`[perf] 画布${canvas.width}x${canvas.height} 总帧=${d.length} 中位=${med.toFixed(1)}ms `
        + `顿挫=${jank}(${((jank / d.length) * 100).toFixed(0)}%) `
        + `[吸入 ${sk.length}帧 中位${skMed.toFixed(1)}ms 顿挫${skJank}]`);
    }
    setTimeout(() => window.api.boomDone(), 50);
  }

  // 复原处理器要在动画之前挂好 —— arm() 之后浮层才会开始吃点击
  window.addEventListener('pointerdown', () => requestRestore('点击'), true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') requestRestore('按键');
  }, true);
  window.api.onHoleDismiss(() => beginRestore());

  window.api.onBoomShot(async (src) => {
    if (!running) return;
    shotEl.src = src;
    try {
      await (shotEl.decode ? shotEl.decode() : Promise.resolve());
      ctx.drawImage(shotEl, 0, 0, 1, 1);   // 提前把纹理推上 GPU
      ctx.clearRect(0, 0, 2, 2);
      hasShot = true;
      buildTiles();
      dlog(`截图已就绪 ${shotEl.naturalWidth}x${shotEl.naturalHeight}`);
    } catch { dlog('截图解码失败，走无截图降级'); }
  });

  window.api.onBoomInit(async (p) => {
    if (running) return;
    if (!p || p.mode !== 'hole') return;
    running = true;
    opt = { ...opt, ...p };
    canvas.style.display = 'block';

    phase = 'form';
    t0 = -1;
    last = 0;
    lastDraw = 0;
    lastVoid = -1;
    pace = 0;
    paceLocked = false;
    paceSamples = [];
    canvas.style.background = 'transparent';
    restoreAt = 0;
    suckAt = FORM_MS;
    hasShot = false;
    tiles = null;
    shotScaled = null;
    armed = false;
    window.__dt = [];
    window.__dtSuck = [];

    // 窗口刚从 1×1 放大回整屏，等布局到位再量尺寸
    for (let i = 0; i < 20; i++) {
      const r = stage.getBoundingClientRect();
      if (r.width > 8 && r.height > 8) break;
      await new Promise((f) => requestAnimationFrame(f));
    }
    resize();
    spawnWisps();
    buildPrompt();

    if (opt.sound) window.api.playSound('suck', opt.volume, (FORM_MS + SUCK_SPREAD + SUCK_TRAVEL) / 1000);
    requestAnimationFrame(frame);
  });

  window.addEventListener('resize', () => { if (running) resize(); });
})();
