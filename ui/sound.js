'use strict';

/* 爆炸音效：WebAudio 实时合成，不依赖任何音频文件。

   这段原本跑在爆炸浮层里。换到 Tauri 之后，浮层是点击穿透、从不获得焦点的窗口，
   WKWebView 不给这种窗口放音的权限，所以挪到主窗口来播 —— 主窗口被用户点过，
   AudioContext 一旦解锁就长期有效。 */

let actx = null;
let volume = 0.7;

function audio() {
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

// 轻微削波，给爆裂声一点毛刺感 —— 纯净的噪声听着「软」
function makeDrive(ac, amount) {
  const ws = ac.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

function playFuse(sec) {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;

  // 引线滋滋声：越烧越近，音量和亮度都往上走
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, sec + 0.1);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2600, now);
  bp.frequency.linearRampToValueAtTime(4200, now + sec);
  bp.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.03 * volume, now);
  g.gain.linearRampToValueAtTime(0.09 * volume, now + sec * 0.85);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(now);
  src.stop(now + sec);

  // 引爆前最后 0.22 秒的上行啸叫，把注意力吊起来
  const whineAt = now + Math.max(0, sec - 0.22);
  const whine = ac.createOscillator();
  const whineG = ac.createGain();
  whine.type = 'sawtooth';
  whine.frequency.setValueAtTime(320, whineAt);
  whine.frequency.exponentialRampToValueAtTime(1900, whineAt + 0.2);
  whineG.gain.setValueAtTime(0.0001, whineAt);
  whineG.gain.exponentialRampToValueAtTime(0.07 * volume, whineAt + 0.16);
  // 引爆前 25ms 掐断 —— 这一小段静默会让紧接着的爆炸显得大得多
  whineG.gain.exponentialRampToValueAtTime(0.0001, whineAt + 0.195);
  whine.connect(whineG).connect(ac.destination);
  whine.start(whineAt);
  whine.stop(whineAt + 0.21);
}

function playBoom() {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(ac.destination);

  // ① 起爆瞬间的爆音：极短的宽频冲击，负责「一拳打在胸口」的那一下
  const snap = ac.createBufferSource();
  snap.buffer = noiseBuffer(ac, 0.06);
  const snapG = ac.createGain();
  snapG.gain.setValueAtTime(1.0, now);
  snapG.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  snap.connect(makeDrive(ac, 4)).connect(snapG).connect(master);
  snap.start(now);

  // ② 低频轰鸣：起点更低、下坠更深、拖得更长
  const sub = ac.createOscillator();
  const subG = ac.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(190, now);
  sub.frequency.exponentialRampToValueAtTime(46, now + 0.28);
  sub.frequency.exponentialRampToValueAtTime(20, now + 1.5);
  subG.gain.setValueAtTime(0.0001, now);
  subG.gain.exponentialRampToValueAtTime(1.25, now + 0.014);
  subG.gain.exponentialRampToValueAtTime(0.0001, now + 1.7);
  sub.connect(subG).connect(master);
  sub.start(now);
  sub.stop(now + 1.75);

  // ③ 爆裂主体：噪声过低通扫频 + 轻微削波
  const body = ac.createBufferSource();
  body.buffer = noiseBuffer(ac, 2.0);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(7000, now);
  lp.frequency.exponentialRampToValueAtTime(90, now + 1.1);
  const bodyG = ac.createGain();
  bodyG.gain.setValueAtTime(0.0001, now);
  bodyG.gain.exponentialRampToValueAtTime(1.1, now + 0.008);
  bodyG.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
  body.connect(lp).connect(makeDrive(ac, 2.2)).connect(bodyG).connect(master);
  body.start(now);

  // ④ 中频冲击：补上「结实」的那一段，不然只有低频和沙沙声
  const punch = ac.createBufferSource();
  punch.buffer = noiseBuffer(ac, 0.5);
  const bpf = ac.createBiquadFilter();
  bpf.type = 'bandpass';
  bpf.frequency.setValueAtTime(900, now);
  bpf.frequency.exponentialRampToValueAtTime(220, now + 0.4);
  bpf.Q.value = 0.8;
  const punchG = ac.createGain();
  punchG.gain.setValueAtTime(0.9, now);
  punchG.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  punch.connect(bpf).connect(punchG).connect(master);
  punch.start(now);

  // ⑤ 二次爆响：两声延迟的闷响，制造「连环炸」的层次
  for (const [at, amp, freq] of [[0.09, 0.55, 120], [0.2, 0.35, 90]]) {
    const t = now + at;
    const s2 = ac.createOscillator();
    const g2 = ac.createGain();
    s2.type = 'sine';
    s2.frequency.setValueAtTime(freq, t);
    s2.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(amp, t + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    s2.connect(g2).connect(master);
    s2.start(t);
    s2.stop(t + 0.65);

    const n2 = ac.createBufferSource();
    n2.buffer = noiseBuffer(ac, 0.4);
    const l2 = ac.createBiquadFilter();
    l2.type = 'lowpass';
    l2.frequency.value = 700;
    const ng2 = ac.createGain();
    ng2.gain.setValueAtTime(amp * 0.6, t);
    ng2.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    n2.connect(l2).connect(ng2).connect(master);
    n2.start(t);
  }

  // ⑥ 高频碎裂：玻璃裂开的那种尖锐感
  const crack = ac.createBufferSource();
  crack.buffer = noiseBuffer(ac, 0.35);
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(2600, now);
  hp.frequency.exponentialRampToValueAtTime(6000, now + 0.3);
  const crackG = ac.createGain();
  crackG.gain.setValueAtTime(0.7, now);
  crackG.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  crack.connect(hp).connect(crackG).connect(master);
  crack.start(now);

  // ⑦ 余震尾巴：慢慢散掉的隆隆声，决定「这场爆炸有多大」
  const tail = ac.createBufferSource();
  tail.buffer = noiseBuffer(ac, 2.8);
  const tlp = ac.createBiquadFilter();
  tlp.type = 'lowpass';
  tlp.frequency.setValueAtTime(420, now);
  tlp.frequency.exponentialRampToValueAtTime(120, now + 2.4);
  const tailG = ac.createGain();
  tailG.gain.setValueAtTime(0.0001, now + 0.04);
  tailG.gain.exponentialRampToValueAtTime(0.5, now + 0.18);
  tailG.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
  tail.connect(tlp).connect(tailG).connect(master);
  tail.start(now + 0.04);
}

window.BoomSound = {
  // 首次交互时解锁 AudioContext，之后自动播放不再受限
  unlock() {
    const go = () => { audio(); };
    window.addEventListener('pointerdown', go, { once: true });
    window.addEventListener('keydown', go, { once: true });
  },
  play(kind, vol, seconds) {
    volume = typeof vol === 'number' ? vol : 0.7;
    if (kind === 'fuse') playFuse(seconds || 0.5);
    else playBoom();
  },
};
