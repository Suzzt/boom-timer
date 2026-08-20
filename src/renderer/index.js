'use strict';

const $ = (id) => document.getElementById(id);
const CIRC = 2 * Math.PI * 88;

let state = null;
let editing = false;

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
  $('volume').value = String(st.volume);

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
$('volume').oninput = (e) => window.api.setSettings({ volume: Number(e.target.value) });
$('perm-btn').onclick = () => window.api.openScreenPermission();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); $('toggle').click(); }
});

window.api.onState(render);
window.api.getState().then(render);
