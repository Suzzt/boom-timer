'use strict';

const {
  app, BrowserWindow, ipcMain, screen, desktopCapturer,
  systemPreferences, Tray, Menu, nativeImage, shell, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');

const PRELOAD = path.join(__dirname, 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');

// ---------------------------------------------------------------- settings

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  minutes: 45,
  loop: true,
  sound: true,
  volume: 0.7,
  intensity: 'normal',   // gentle | normal | nuke
  fuse: true,            // 引爆前有 0.5s 引线滋滋声
  allScreens: true,
  messages: [
    '起来动一动！', '喝口水吧', '看看远处，眼睛该歇了',
    '站起来伸个懒腰', '肩膀转两圈', '别坐了，走两步',
  ],
};

let settings = { ...DEFAULTS };

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = { ...DEFAULTS, ...raw };
  } catch { /* 首次运行，用默认值 */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

// ---------------------------------------------------------------- timer

const timer = {
  running: false,
  endAt: 0,
  remainingMs: DEFAULTS.minutes * 60000,
  totalMs: DEFAULTS.minutes * 60000,
};

let ticker = null;
let controlWin = null;
let tray = null;
let booming = false;
const boomWins = new Set();

function broadcastState() {
  const payload = {
    running: timer.running,
    remainingMs: Math.max(0, timer.remainingMs),
    totalMs: timer.totalMs,
    settings,
    screenPermission: screenPermissionState(),
  };
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('state', payload);
  updateTray();
  return payload;
}

function startTimer(minutes) {
  if (typeof minutes === 'number' && minutes > 0) {
    settings.minutes = minutes;
    saveSettings();
    timer.totalMs = Math.round(minutes * 60000);
    timer.remainingMs = timer.totalMs;
  } else if (!timer.running && timer.remainingMs <= 0) {
    timer.remainingMs = timer.totalMs;
  }
  timer.endAt = Date.now() + timer.remainingMs;
  timer.running = true;
  startTicker();
  broadcastState();
}

function pauseTimer() {
  if (!timer.running) return;
  timer.remainingMs = Math.max(0, timer.endAt - Date.now());
  timer.running = false;
  stopTicker();
  broadcastState();
}

function resetTimer() {
  timer.running = false;
  stopTicker();
  timer.totalMs = Math.round(settings.minutes * 60000);
  timer.remainingMs = timer.totalMs;
  broadcastState();
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!timer.running) return;
    timer.remainingMs = timer.endAt - Date.now();
    if (timer.remainingMs <= 0) {
      timer.remainingMs = 0;
      timer.running = false;
      stopTicker();
      broadcastState();
      detonate().then(() => {
        if (settings.loop) {
          timer.totalMs = Math.round(settings.minutes * 60000);
          timer.remainingMs = timer.totalMs;
          startTimer();
        } else {
          resetTimer();
        }
      });
      return;
    }
    broadcastState();
  }, 250);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

// 系统休眠/唤醒后重新对齐剩余时间，避免倒计时跑偏
powerMonitor.on('resume', () => {
  if (timer.running) timer.remainingMs = Math.max(0, timer.endAt - Date.now());
});

// ---------------------------------------------------------------- screen capture

function screenPermissionState() {
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}

// 抓取每个屏幕的快照，用来做「整块屏幕被震动」的效果。
// 拿不到（未授权 / 失败）就返回空 Map，渲染端自动降级成透明浮层。
async function captureScreens() {
  const shots = new Map();
  // not-determined 时也要试一次：正是这次尝试才会触发 macOS 的授权弹窗。
  // 明确被拒绝才直接放弃，走透明浮层降级。
  const perm = screenPermissionState();
  if (perm === 'denied' || perm === 'restricted') return shots;

  try {
    const displays = screen.getAllDisplays();
    let w = 0, h = 0;
    for (const d of displays) {
      const s = Math.min(d.scaleFactor || 1, 2);
      w = Math.max(w, Math.round(d.bounds.width * s));
      h = Math.max(h, Math.round(d.bounds.height * s));
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
      fetchWindowIcons: false,
    });
    for (const src of sources) {
      if (!src.thumbnail || src.thumbnail.isEmpty()) continue;
      const jpeg = src.thumbnail.toJPEG(72);
      if (!jpeg || jpeg.length < 1024) continue;
      shots.set(String(src.display_id || ''), 'data:image/jpeg;base64,' + jpeg.toString('base64'));
    }
  } catch (err) {
    console.error('屏幕快照失败，降级为透明浮层:', err.message);
  }
  return shots;
}

// ---------------------------------------------------------------- boom

function createBoomWindow(display, shot, isPrimary) {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: false });   // 完全点击穿透，不打断用户操作
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  const payload = {
    shot: shot || null,
    intensity: settings.intensity,
    sound: settings.sound && isPrimary,   // 多屏时只让主屏出声，避免声音叠加
    volume: settings.volume,
    fuse: settings.fuse,
    text: settings.messages[Math.floor(Math.random() * settings.messages.length)] || '',
  };

  const kill = () => { if (!win.isDestroyed()) win.destroy(); boomWins.delete(win); };

  ipcMain.once(`boom:ready:${win.webContents.id}`, () => {
    if (win.isDestroyed()) return;
    win.webContents.send('boom:init', payload);
    win.showInactive();
  });
  ipcMain.once(`boom:done:${win.webContents.id}`, kill);

  const safety = setTimeout(kill, 12000);   // 兜底：动画卡住也不会留一个透明窗口
  win.on('closed', () => { clearTimeout(safety); boomWins.delete(win); });

  win.loadFile(path.join(RENDERER, 'boom.html'));
  boomWins.add(win);
  return win;
}

async function detonate() {
  if (booming) return;
  booming = true;
  try {
    const shots = await captureScreens();
    const displays = settings.allScreens ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
    const primaryId = screen.getPrimaryDisplay().id;
    const wins = displays.map((d) =>
      createBoomWindow(d, shots.get(String(d.id)), d.id === primaryId || displays.length === 1));
    await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const alive = wins.some((w) => !w.isDestroyed());
        if (!alive || Date.now() - t0 > 13000) { clearInterval(poll); resolve(); }
      }, 200);
    });
  } finally {
    booming = false;
  }
}

// ---------------------------------------------------------------- control window

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 420,
    height: 660,
    minWidth: 380,
    minHeight: 600,
    title: 'BoomTimer',
    backgroundColor: '#0e1116',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  controlWin.loadFile(path.join(RENDERER, 'index.html'));
  controlWin.once('ready-to-show', () => controlWin.show());
  controlWin.on('closed', () => { controlWin = null; });
  return controlWin;
}

function showControlWindow() {
  if (!controlWin || controlWin.isDestroyed()) createControlWindow();
  else { controlWin.show(); controlWin.focus(); }
}

// ---------------------------------------------------------------- tray

function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`BoomTimer — ${timer.running ? fmt(timer.remainingMs) : '已暂停'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: timer.running ? `倒计时 ${fmt(timer.remainingMs)}` : '已暂停', enabled: false },
    { type: 'separator' },
    { label: timer.running ? '暂停' : '开始', click: () => (timer.running ? pauseTimer() : startTimer()) },
    { label: '重置', click: resetTimer },
    { label: '💣 立即引爆', click: () => detonate() },
    { type: 'separator' },
    { label: '显示主界面', click: showControlWindow },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  let img = nativeImage.createEmpty();
  if (fs.existsSync(ICON_PATH)) {
    img = nativeImage.createFromPath(ICON_PATH).resize({ width: 18, height: 18 });
    if (process.platform === 'darwin') img.setTemplateImage(false);
  }
  try {
    tray = new Tray(img);
    tray.on('click', showControlWindow);
    updateTray();
  } catch (err) {
    console.error('托盘创建失败:', err.message);
  }
}

// ---------------------------------------------------------------- ipc

ipcMain.handle('state:get', () => broadcastState());
ipcMain.on('timer:start', (_e, minutes) => startTimer(minutes));
ipcMain.on('timer:pause', pauseTimer);
ipcMain.on('timer:reset', resetTimer);
ipcMain.on('timer:boom', () => detonate());
ipcMain.on('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  if (!timer.running && typeof patch.minutes === 'number') {
    timer.totalMs = Math.round(settings.minutes * 60000);
    timer.remainingMs = timer.totalMs;
  }
  broadcastState();
});
ipcMain.on('perm:open', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});
ipcMain.on('boom:ready', (e) => ipcMain.emit(`boom:ready:${e.sender.id}`));
ipcMain.on('boom:done', (e) => ipcMain.emit(`boom:done:${e.sender.id}`));

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showControlWindow);

  app.whenReady().then(() => {
    loadSettings();
    timer.totalMs = Math.round(settings.minutes * 60000);
    timer.remainingMs = timer.totalMs;
    createControlWindow();
    createTray();
    app.on('activate', showControlWindow);
  });

  app.on('window-all-closed', () => {
    // 有托盘就常驻后台，倒计时继续跑
    if (!tray && process.platform !== 'darwin') app.quit();
  });
}
