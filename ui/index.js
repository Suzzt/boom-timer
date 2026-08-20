'use strict';

const $ = (id) => document.getElementById(id);
const CIRC = 2 * Math.PI * 88;

let state = null;
let editing = false;
// 滑块最近一次被拖动的时刻。250ms 的状态广播不能在用户还在拖的时候
// 把值改回去 —— 分钟输入框用 focus/blur 守卫，滑块用时间窗更稳（拖动
// 过程中的 focus/pointer 事件在各引擎上不完全一致）。
let volTouchedAt = 0;
let volTimer = null;

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function render(s) {
  state = s;
  $('clock').textContent = fmt(s.remainingMs);
  $('status').textContent = s.running ? '倒计时中…' : (s.remainingMs <= 0 ? '已引爆' : '已暂停');
  $('toggle').textContent = s.running ? '暂停' : '开始';

  const ratio = s.totalMs > 0 ? s.remainingMs / s.totalMs : 0;
  $('prog').style.strokeDasharray = String(CIRC);
  $('prog').style.strokeDashoffset = String(CIRC * (1 - ratio));

  const st = s.settings;
  if (!editing) $('min').value = String(st.minutes);
  $('loop').checked = !!st.loop;
  $('sound').checked = !!st.sound;
  $('fuse').checked = !!st.fuse;
  $('allScreens').checked = !!st.allScreens;
  if (Date.now() - volTouchedAt > 400) $('volume').value = String(st.volume);

  for (const b of document.querySelectorAll('#presets button')) {
    b.classList.toggle('on', Number(b.dataset.min) === Number(st.minutes));
  }
  for (const b of document.querySelectorAll('#intensity button')) {
    b.classList.toggle('on', b.dataset.v === st.intensity);
  }

  $('perm').classList.toggle('hidden', s.screenPermission === 'granted');
}

function currentMinutes() {
  const v = parseFloat($('min').value);
  return Number.isFinite(v) && v > 0 ? Math.min(600, v) : 45;
}

// --- 事件绑定

$('toggle').onclick = () => {
  if (state && state.running) window.api.pause();
  else window.api.start(currentMinutes());
};
$('reset').onclick = () => window.api.reset();
$('boom').onclick = () => window.api.boomNow();

for (const b of document.querySelectorAll('#presets button')) {
  b.onclick = () => {
    $('min').value = b.dataset.min;
    window.api.setSettings({ minutes: Number(b.dataset.min) });
    if (state && state.running) window.api.start(Number(b.dataset.min));
  };
}

for (const b of document.querySelectorAll('#intensity button')) {
  b.onclick = () => window.api.setSettings({ intensity: b.dataset.v });
}

$('min').addEventListener('focus', () => { editing = true; });
$('min').addEventListener('blur', () => {
  editing = false;
  window.api.setSettings({ minutes: currentMinutes() });
});
$('min').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('min').blur(); });

$('loop').onchange = (e) => window.api.setSettings({ loop: e.target.checked });
$('sound').onchange = (e) => window.api.setSettings({ sound: e.target.checked });
$('fuse').onchange = (e) => window.api.setSettings({ fuse: e.target.checked });
$('allScreens').onchange = (e) => window.api.setSettings({ allScreens: e.target.checked });
// 拖动时不要每个像素都走一遍 IPC + 同步写盘 + 原生托盘更新：
// 本地立刻回显保证跟手，落盘最多每 100ms 一次，松手时补一次最终值。
$('volume').oninput = (e) => {
  volTouchedAt = Date.now();
  if (state) state.settings.volume = Number(e.target.value);
  if (volTimer) return;
  volTimer = setTimeout(() => {
    volTimer = null;
    window.api.setSettings({ volume: Number($('volume').value) });
  }, 100);
};
$('volume').onchange = () => {
  if (volTimer) { clearTimeout(volTimer); volTimer = null; }
  volTouchedAt = Date.now();
  window.api.setSettings({ volume: Number($('volume').value) });
};
$('perm-btn').onclick = () => window.api.openScreenPermission();
$('restart-btn').onclick = () => window.api.restartApp();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); $('toggle').click(); }
});

// 音效由主窗口代播：先在首次交互时解锁 AudioContext
window.BoomSound.unlock();
window.__TAURI__.event.listen('play-sound', (e) => {
  const { kind, volume, seconds } = e.payload || {};
  window.BoomSound.play(kind, volume, seconds);
});

window.api.onState(render);
window.api.getState().then(render);
