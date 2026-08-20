#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

// ---------------------------------------------------------------- 设置

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Settings {
    minutes: f64,
    #[serde(rename = "loop")]
    loop_on: bool,
    sound: bool,
    volume: f64,
    intensity: String,
    fuse: bool,
    #[serde(rename = "allScreens")]
    all_screens: bool,
    messages: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            minutes: 45.0,
            loop_on: true,
            sound: true,
            volume: 0.7,
            intensity: "normal".into(),
            fuse: true,
            all_screens: false,
            messages: vec![
                "起来动一动！".into(),
                "喝口水吧".into(),
                "看看远处，眼睛该歇了".into(),
                "站起来伸个懒腰".into(),
                "肩膀转两圈".into(),
                "别坐了，走两步".into(),
            ],
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        if let Ok(txt) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(p, txt);
        }
    }
}

// ---------------------------------------------------------------- 状态

struct Timer {
    running: bool,
    end_at: u128,
    remaining_ms: i64,
    total_ms: i64,
}

struct AppState {
    settings: Settings,
    timer: Timer,
    booming: bool,
    /// 每个爆炸窗口的初始化载荷，等前端 boom_ready 时取走
    pending: HashMap<String, BoomPayload>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    running: bool,
    remaining_ms: i64,
    total_ms: i64,
    settings: Settings,
    screen_permission: String,
}

#[derive(Serialize, Clone, Debug)]
struct BoomPayload {
    shot: Option<String>,
    /// 实验用：覆盖画布像素上限（BOOM_MAXPX）
    #[serde(rename = "maxPx")]
    max_px: Option<f64>,
    /// 副屏走轻量档：两个全屏浮层同时跑会互相抢 GPU，把帧率从 60 拖到 20
    primary: bool,
    intensity: String,
    sound: bool,
    volume: f64,
    fuse: bool,
    text: String,
}

/// 屏幕录制权限的判定结果缓存。
///
/// 绝对不能只信 CGPreflightScreenCaptureAccess —— 本应用没有代码签名，
/// 而 TCC 是靠签名认应用身份的：系统会放行抓屏（用户确实授权了），
/// 但这个查询 API 认不出这个未签名的二进制，一律回答 denied。
/// 实测日志：`CGPreflight=denied 实际抓图=true`。
/// 所以判定标准改成「能不能真的抓到一张 8×8 的小图」—— 以能力为准，不问系统。
/// 哪天真做了签名，CGPreflight 这条快路径会自然生效。
static SCREEN_OK: AtomicBool = AtomicBool::new(false);
static LAST_PROBE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn screen_state() -> &'static str {
    if SCREEN_OK.load(Ordering::Relaxed) {
        "granted"
    } else {
        "denied"
    }
}

/// 试抓一张极小的图，验证当下是否真的抓得动
#[cfg(target_os = "macos")]
fn probe_capture(app: &AppHandle) -> bool {
    let Some(dir) = shot_dir(app) else { return false };
    let path = dir.join("probe.jpg");
    let _ = std::fs::remove_file(&path);
    let ok = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "jpg", "-R", "0,0,8,8"])
        .arg(&path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let good = ok
        && std::fs::metadata(&path)
            .map(|m| m.len() > 100)
            .unwrap_or(false);
    let _ = std::fs::remove_file(&path);
    good
}

/// Windows / Linux 上抓屏不需要用户授权
#[cfg(not(target_os = "macos"))]
fn probe_capture(_app: &AppHandle) -> bool {
    true
}

/// 诊断日志：只在设置了 BOOM_DEBUG 时写盘。
/// 保留它的理由 —— 前端一旦静默出错（比如 Tauri ACL 拒掉某个调用），
/// 没有这条通道就只能靠猜。
fn dbg_log(app: &AppHandle, msg: &str) {
    if std::env::var("BOOM_DEBUG").is_err() {
        return;
    }
    if let Some(dir) = shot_dir(app) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("diag.log"))
        {
            let _ = writeln!(f, "{} {}", now_ms(), msg);
        }
    }
}

#[tauri::command]
fn dev_log(app: AppHandle, msg: String) {
    dbg_log(&app, &format!("[js] {msg}"));
}

fn snapshot(app: &AppHandle) -> StatePayload {
    let st = app.state::<Mutex<AppState>>();
    let s = st.lock().unwrap();
    StatePayload {
        running: s.timer.running,
        remaining_ms: s.timer.remaining_ms.max(0),
        total_ms: s.timer.total_ms,
        settings: s.settings.clone(),
        screen_permission: screen_state().to_string(),
    }
}

fn broadcast(app: &AppHandle) {
    let payload = snapshot(app);
    let _ = app.emit("state", &payload);
    update_tray(app, &payload);
}

// ---------------------------------------------------------------- 计时

#[tauri::command]
fn get_state(app: AppHandle) -> StatePayload {
    snapshot(&app)
}

#[tauri::command]
fn start_timer(app: AppHandle, minutes: Option<f64>) {
    {
        let st = app.state::<Mutex<AppState>>();
        let mut s = st.lock().unwrap();
        if let Some(m) = minutes.filter(|m| *m > 0.0) {
            s.settings.minutes = m;
            s.timer.total_ms = (m * 60000.0) as i64;
            s.timer.remaining_ms = s.timer.total_ms;
        } else if !s.timer.running && s.timer.remaining_ms <= 0 {
            s.timer.remaining_ms = s.timer.total_ms;
        }
        s.timer.end_at = now_ms() + s.timer.remaining_ms.max(0) as u128;
        s.timer.running = true;
        let cloned = s.settings.clone();
        drop(s);
        save_settings(&app, &cloned);
    }
    broadcast(&app);
}

#[tauri::command]
fn pause_timer(app: AppHandle) {
    {
        let st = app.state::<Mutex<AppState>>();
        let mut s = st.lock().unwrap();
        if !s.timer.running {
            return;
        }
        s.timer.remaining_ms = (s.timer.end_at as i128 - now_ms() as i128).max(0) as i64;
        s.timer.running = false;
    }
    broadcast(&app);
}

#[tauri::command]
fn reset_timer(app: AppHandle) {
    {
        let st = app.state::<Mutex<AppState>>();
        let mut s = st.lock().unwrap();
        s.timer.running = false;
        s.timer.total_ms = (s.settings.minutes * 60000.0) as i64;
        s.timer.remaining_ms = s.timer.total_ms;
    }
    broadcast(&app);
}

#[tauri::command]
fn set_settings(app: AppHandle, patch: serde_json::Value) {
    {
        let st = app.state::<Mutex<AppState>>();
        let mut s = st.lock().unwrap();
        let mut cur = serde_json::to_value(&s.settings).unwrap_or_default();
        if let (Some(obj), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                obj.insert(k.clone(), v.clone());
            }
        }
        if let Ok(next) = serde_json::from_value::<Settings>(cur) {
            let changed_minutes = next.minutes != s.settings.minutes;
            s.settings = next;
            if !s.timer.running && changed_minutes {
                s.timer.total_ms = (s.settings.minutes * 60000.0) as i64;
                s.timer.remaining_ms = s.timer.total_ms;
            }
        }
        let cloned = s.settings.clone();
        drop(s);
        save_settings(&app, &cloned);
    }
    broadcast(&app);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn open_screen_permission() {
    // 先试着触发系统弹窗；已经拒绝过的话直接把设置面板打开
    if !platform::request_screen_permission() {
        platform::open_screen_settings();
    }
}

// ---------------------------------------------------------------- 屏幕快照

/// 抓取每块屏幕，返回 物理坐标key -> 临时 JPEG 文件路径。
/// 失败就返回空表，前端自动降级成透明浮层。
///
/// macOS 上不用 xcap 抓图：它走的是废弃的 CGWindowListCreateImage，
/// 被系统降级成每次调用都重启一遍 ScreenCaptureKit，单屏就要 2.3 秒。
/// 系统自带的 screencapture 走的是现代路径，同样两块屏只要 0.44 秒。
fn capture_screens(app: &AppHandle, mons: &[MonitorInfo]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if mons.is_empty() {
        return out;
    }
    let Some(dir) = shot_dir(app) else { return out };

    let mut jobs = Vec::new();
    for (i, m) in mons.iter().enumerate() {
        let path = dir.join(format!("shot-{}-{}.jpg", now_ms(), i));
        let key = format!("{}:{}", m.key_x, m.key_y);
        let expect = (m.px_w, m.px_h);
        let idx = m.index;
        jobs.push(std::thread::spawn(move || {
            grab(idx, &path, expect).then(|| (key, path.to_string_lossy().into_owned()))
        }));
    }
    for j in jobs {
        if let Ok(Some((k, p))) = j.join() {
            out.insert(k, p);
        }
    }
    out
}

fn shot_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_cache_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// 抓单块屏，成功返回 true。抓完校验一下尺寸，防止显示器索引对不上。
#[cfg(target_os = "macos")]
fn grab(display_index: usize, path: &std::path::Path, expect: (u32, u32)) -> bool {
    let ok = std::process::Command::new("/usr/sbin/screencapture")
        .args([
            "-x",
            "-t",
            "jpg",
            "-D",
            &(display_index + 1).to_string(),
        ])
        .arg(path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok || !path.exists() {
        return false;
    }
    match image::image_dimensions(path) {
        Ok((w, h)) if w == expect.0 && h == expect.1 => true,
        Ok((w, h)) => {
            eprintln!("[shot] 显示器 {} 尺寸对不上 {}x{} != {:?}", display_index, w, h, expect);
            let _ = std::fs::remove_file(path);
            false
        }
        Err(_) => false,
    }
}

#[cfg(not(target_os = "macos"))]
fn grab(display_index: usize, path: &std::path::Path, _expect: (u32, u32)) -> bool {
    let Ok(monitors) = xcap::Monitor::all() else { return false };
    let Some(m) = monitors.get(display_index) else { return false };
    let Ok(img) = m.capture_image() else { return false };
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let Ok(file) = std::fs::File::create(path) else { return false };
    let mut w = std::io::BufWriter::new(file);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 80)
        .encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .is_ok()
}

/// 清掉上一轮留下的临时截图
fn sweep_shots(app: &AppHandle) {
    if let Some(dir) = shot_dir(app) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("shot-") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}

// ---------------------------------------------------------------- 爆炸

#[tauri::command]
fn detonate(app: AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || boom(handle));
}

fn boom(app: AppHandle) {
    {
        let st = app.state::<Mutex<AppState>>();
        let mut s = st.lock().unwrap();
        if s.booming {
            return;
        }
        s.booming = true;
    }

    sweep_shots(&app);
    let all = monitors();
    let want_all = {
        let st = app.state::<Mutex<AppState>>();
        let s = st.lock().unwrap();
        s.settings.all_screens
    };
    let mons: Vec<MonitorInfo> = if want_all {
        all.clone()
    } else {
        all.iter().find(|m| m.primary).copied().into_iter().collect()
    };

    let shots = capture_screens(&app, &mons);

    // 建窗口必须待在后台线程：build() 内部会派发到主线程并阻塞等待，
    // 在主线程闭包里调用会直接死锁。
    let labels = spawn_overlays(&app, shots, mons);

    // 等浮层放完自己关闭，最多兜底 12 秒
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    loop {
        std::thread::sleep(Duration::from_millis(200));
        let alive = labels.iter().any(|l| app.get_webview_window(l).is_some());
        if !alive || std::time::Instant::now() > deadline {
            break;
        }
    }
    for l in &labels {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.destroy();
        }
    }

    sweep_shots(&app);

    {
        let st = app.state::<Mutex<AppState>>();
        st.lock().unwrap().booming = false;
    }

    let looping = {
        let st = app.state::<Mutex<AppState>>();
        let s = st.lock().unwrap();
        s.settings.loop_on
    };
    if looping {
        start_timer(app.clone(), None);
    } else {
        reset_timer(app.clone());
    }
}

#[derive(Clone, Copy, Debug)]
struct MonitorInfo {
    /// 逻辑坐标（Tauri 的窗口 API 用的就是这个单位）
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// 物理坐标，用来和屏幕快照对应
    key_x: i32,
    key_y: i32,
    /// 物理像素尺寸，用来校验抓到的图是不是这块屏
    px_w: u32,
    px_h: u32,
    index: usize,
    primary: bool,
}

// xcap 的坐标语义分平台：macOS 给的是逻辑点，Windows 给的是物理像素
#[cfg(target_os = "macos")]
const XCAP_LOGICAL: bool = true;
#[cfg(not(target_os = "macos"))]
const XCAP_LOGICAL: bool = false;

/// 显示器信息统一走 xcap —— 它不依赖 Tauri 事件循环，任何线程都能安全调用
fn monitors() -> Vec<MonitorInfo> {
    let Ok(list) = xcap::Monitor::all() else {
        return Vec::new();
    };
    list.iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let (x, y) = (m.x().ok()?, m.y().ok()?);
            let (w, h) = (m.width().ok()?, m.height().ok()?);
            let scale = m.scale_factor().unwrap_or(1.0).max(0.1) as f64;
            let k = if XCAP_LOGICAL { 1.0 } else { scale };
            Some(MonitorInfo {
                x: x as f64 / k,
                y: y as f64 / k,
                w: w as f64 / k,
                h: h as f64 / k,
                key_x: x,
                key_y: y,
                px_w: (w as f64 * if XCAP_LOGICAL { scale } else { 1.0 }).round() as u32,
                px_h: (h as f64 * if XCAP_LOGICAL { scale } else { 1.0 }).round() as u32,
                index: i,
                primary: m.is_primary().unwrap_or(false),
            })
        })
        .collect()
}

/// 在后台线程调用；其中只有原生 objc 那一步会切回主线程
fn spawn_overlays(
    app: &AppHandle,
    shots: HashMap<String, String>,
    mons: Vec<MonitorInfo>,
) -> Vec<String> {
    let settings = {
        let st = app.state::<Mutex<AppState>>();
        let s = st.lock().unwrap();
        s.settings.clone()
    };

    let targets = mons;

    let mut labels = Vec::new();
    for (i, mon) in targets.iter().enumerate() {
        let key = format!("{}:{}", mon.key_x, mon.key_y);
        let is_primary = mon.primary || (targets.len() == 1);

        let text = if settings.messages.is_empty() {
            String::new()
        } else {
            // 不引入 rand：用时间戳做个够用的随机
            settings.messages[(now_ms() as usize + i * 7) % settings.messages.len()].clone()
        };

        let payload = BoomPayload {
            shot: shots.get(&key).cloned(),
            max_px: std::env::var("BOOM_MAXPX").ok().and_then(|v| v.parse().ok()),
            primary: is_primary,
            intensity: settings.intensity.clone(),
            sound: settings.sound && is_primary,
            volume: settings.volume,
            fuse: settings.fuse,
            text,
        };

        let label = format!("boom-{}-{}", now_ms(), i);
        {
            let st = app.state::<Mutex<AppState>>();
            st.lock().unwrap().pending.insert(label.clone(), payload);
        }

        // position / inner_size 都是逻辑单位，MonitorInfo 已经换算好了
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("boom.html".into()))
            .title("")
            .position(mon.x, mon.y)
            .inner_size(mon.w, mon.h)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build();

        match built {
            Ok(win) => {
                let _ = win.set_ignore_cursor_events(true);
                let _ = win.set_visible_on_all_workspaces(true);
                // 原生 NSWindow 操作必须在主线程，否则 AppKit 直接 SIGILL
                let w2 = win.clone();
                let _ = app.run_on_main_thread(move || platform::raise_overlay(&w2));
                let _ = win.show();
                labels.push(label);
            }
            Err(e) => {
                eprintln!("爆炸窗口创建失败: {e}");
                let st = app.state::<Mutex<AppState>>();
                st.lock().unwrap().pending.remove(&label);
            }
        }
    }
    labels
}

#[tauri::command]
fn boom_ready(app: AppHandle, window: tauri::Window) -> Option<BoomPayload> {
    let st = app.state::<Mutex<AppState>>();
    let mut s = st.lock().unwrap();
    s.pending.remove(window.label())
}

#[tauri::command]
fn boom_done(app: AppHandle, window: tauri::Window) {
    if let Some(w) = app.get_webview_window(window.label()) {
        let _ = w.destroy();
    }
}

/// 浮层窗口从不获得焦点，WKWebView 里放不出声；改由主窗口代播
#[tauri::command]
fn play_sound(app: AppHandle, kind: String, volume: f64, seconds: f64) {
    let _ = app.emit_to(
        "main",
        "play-sound",
        serde_json::json!({ "kind": kind, "volume": volume, "seconds": seconds }),
    );
}

// ---------------------------------------------------------------- 托盘

fn fmt_ms(ms: i64) -> String {
    let s = (ms.max(0) as f64 / 1000.0).round() as i64;
    format!("{:02}:{:02}", s / 60, s % 60)
}

fn update_tray(app: &AppHandle, state: &StatePayload) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if state.running {
            format!("BoomTimer — {}", fmt_ms(state.remaining_ms))
        } else {
            "BoomTimer — 已暂停".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------- 入口

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(AppState {
            settings: Settings::default(),
            timer: Timer {
                running: false,
                end_at: 0,
                remaining_ms: 45 * 60000,
                total_ms: 45 * 60000,
            },
            booming: false,
            pending: HashMap::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            get_state,
            start_timer,
            pause_timer,
            reset_timer,
            set_settings,
            open_screen_permission,
            restart_app,
            dev_log,
            detonate,
            boom_ready,
            boom_done,
            play_sound,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 载入持久化设置
            {
                let loaded = load_settings(&handle);
                let st = handle.state::<Mutex<AppState>>();
                let mut s = st.lock().unwrap();
                s.timer.total_ms = (loaded.minutes * 60000.0) as i64;
                s.timer.remaining_ms = s.timer.total_ms;
                s.settings = loaded;
            }

            // 托盘
            let show_i = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let boom_i = MenuItem::with_id(app, "boom", "💣 立即引爆", true, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "toggle", "开始 / 暂停", true, None::<&str>)?;
            let reset_i = MenuItem::with_id(app, "reset", "重置", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&toggle_i, &reset_i, &boom_i, &sep, &show_i, &quit_i],
            )?;

            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("BoomTimer")
                .on_menu_event(|app, event| {
                    let app = app.clone();
                    match event.id().as_ref() {
                        "show" => show_main(&app),
                        "boom" => detonate(app.clone()),
                        "reset" => reset_timer(app.clone()),
                        "toggle" => {
                            let running = {
                                let st = app.state::<Mutex<AppState>>();
                                let s = st.lock().unwrap();
                                s.timer.running
                            };
                            if running {
                                pause_timer(app.clone())
                            } else {
                                start_timer(app.clone(), None)
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            // 主窗口关闭时只隐藏，保证托盘常驻 + 音频上下文存活
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_size(LogicalSize::new(420.0, 660.0));
                let w = main.clone();
                let h2 = handle.clone();
                main.on_window_event(move |e| match e {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                    // 用户从「系统设置」切回来时重探一次，但至少间隔 20 秒，
                    // 否则来回切窗口就会不停弹权限框
                    WindowEvent::Focused(true) => {
                        if !SCREEN_OK.load(Ordering::Relaxed) {
                            let now = now_ms();
                            let last = LAST_PROBE.load(Ordering::Relaxed);
                            if now.saturating_sub(last as u128) > 20_000 {
                                LAST_PROBE.store(now as u64, Ordering::Relaxed);
                                let h3 = h2.clone();
                                std::thread::spawn(move || {
                                    if probe_capture(&h3) {
                                        SCREEN_OK.store(true, Ordering::Relaxed);
                                        broadcast(&h3);
                                    }
                                });
                            }
                        }
                    }
                    _ => {}
                });
            }

            // 权限探测只在启动时做一次。
            // 每次探测都会拉起 screencapture 子进程，未获授权时系统会弹框，
            // 所以绝不能定时轮询 —— 那会变成没完没了的弹窗骚扰。
            let probe = handle.clone();
            std::thread::spawn(move || {
                if platform::screen_permission() == "granted" || probe_capture(&probe) {
                    SCREEN_OK.store(true, Ordering::Relaxed);
                    broadcast(&probe);
                }
                dbg_log(&probe, &format!("启动探测: 结果={}", screen_state()));
            });

            // 计时线程
            let tick = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(250));
                let fire = {
                    let st = tick.state::<Mutex<AppState>>();
                    let mut s = st.lock().unwrap();
                    if !s.timer.running {
                        false
                    } else {
                        s.timer.remaining_ms = (s.timer.end_at as i128 - now_ms() as i128) as i64;
                        if s.timer.remaining_ms <= 0 {
                            s.timer.remaining_ms = 0;
                            s.timer.running = false;
                            true
                        } else {
                            false
                        }
                    }
                };
                broadcast(&tick);
                if fire {
                    let h = tick.clone();
                    std::thread::spawn(move || boom(h));
                }
            });

            if let Ok(ms) = std::env::var("BOOM_TEST") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ms.parse().unwrap_or(4000)));
                    boom(h);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
