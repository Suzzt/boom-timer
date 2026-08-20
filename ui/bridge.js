'use strict';

/* 把 Electron 时代的 window.api 映射到 Tauri 的 invoke / event，
   让渲染层代码（index.js、boom.js）不用为换壳而改写。 */

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let boomInitCb = null;

window.api = {
  // --- 控制台
  getState: () => invoke('get_state'),
  onState: (cb) => listen('state', (e) => cb(e.payload)),
  start: (minutes) => invoke('start_timer', { minutes: minutes ?? null }),
  pause: () => invoke('pause_timer'),
  reset: () => invoke('reset_timer'),
  boomNow: () => invoke('detonate'),
  setSettings: (patch) => invoke('set_settings', { patch }),
  openScreenPermission: () => invoke('open_screen_permission'),
  restartApp: () => invoke('restart_app'),
  log: (m) => invoke('dev_log', { msg: String(m) }),

  // --- 爆炸浮层
  onBoomInit: (cb) => { boomInitCb = cb; },
  boomReady: () => invoke('boom_ready').then((p) => {
    if (!p || !boomInitCb) return;
    // 截图以文件路径传过来，走 asset 协议加载，避免几 MB 的 base64 挤 IPC
    if (p.shot) p.shot = convertFileSrc(p.shot);
    if (p.maxPx) window.__maxpx = p.maxPx;
    boomInitCb(p);
  }),
  boomDone: () => invoke('boom_done'),

  // 浮层永不获得焦点，WKWebView 下放不出声，交给主窗口代播
  playSound: (kind, volume, seconds) =>
    invoke('play_sound', { kind, volume, seconds: seconds ?? 0 }),
};


window.addEventListener('error', (e) => {
  window.api.log(`前端异常 ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  window.api.log(`未捕获的 Promise 拒绝 ${e.reason}`);
});
