'use strict';

/* 把 Electron 时代的 window.api 映射到 Tauri 的 invoke / event，
   让渲染层代码（index.js、boom.js）不用为换壳而改写。 */

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;


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
  // 浮层是常驻复用的：每次引爆由后端发 boom-go 事件带着载荷过来
  onBoomInit: (cb) => listen('boom-go', (e) => {
    const p = e.payload || {};
    if (p.maxPx) window.__maxpx = p.maxPx;
    if (p.holeCols) window.__holeCols = p.holeCols;
    cb(p);
  }),
  // 截图是异步送达的：窗口先建、动画先跑，抓完再通过事件把文件路径推过来
  onBoomShot: (cb) => listen('boom-shot', (e) => cb(convertFileSrc(e.payload))),
  boomDone: () => invoke('boom_done'),

  // 黑洞模式：前端挂好复原处理器之后才让 Rust 打开点击捕获
  holeArmed: () => invoke('hole_armed'),
  // 任意一块屏上点一下，广播给所有屏一起复原
  holeDismiss: () => invoke('hole_dismiss'),
  onHoleDismiss: (cb) => listen('hole-dismiss', () => cb()),

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
