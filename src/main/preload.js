'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- 控制台
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  start: (minutes) => ipcRenderer.send('timer:start', minutes),
  pause: () => ipcRenderer.send('timer:pause'),
  reset: () => ipcRenderer.send('timer:reset'),
  boomNow: () => ipcRenderer.send('timer:boom'),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  openScreenPermission: () => ipcRenderer.send('perm:open'),

  // --- 爆炸浮层
  boomReady: () => ipcRenderer.send('boom:ready'),
  boomDone: () => ipcRenderer.send('boom:done'),
  onBoomInit: (cb) => ipcRenderer.on('boom:init', (_e, p) => cb(p)),
});
