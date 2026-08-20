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
  g.gain.value = 0.05 * volume;
  src.connect(bp).connect(g).connect(ac.destination);
  src.start();
  src.stop(ac.currentTime + sec);
}

function playBoom() {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const vol = volume;
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
