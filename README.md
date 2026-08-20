# 💣 BoomTimer

上班族解压定时器：时间一到，一颗 3D 炸弹从屏幕正中央由远及近飞来，炸开的瞬间**整块屏幕跟着抖三抖**，然后提醒你起来动一动。

macOS 与 Windows 双端。

## 下载

[**→ 前往 Releases 下载**](https://github.com/Suzzt/boom-timer/releases/latest)

| 平台 | 文件 | 体积 |
| --- | --- | --- |
| macOS Apple Silicon | `BoomTimer_1.0.0_aarch64.dmg` | 2.5 MB |
| macOS Intel | `BoomTimer_1.0.0_x64.dmg` | 2.6 MB |
| Windows 安装版 | `BoomTimer_1.0.0_x64-setup.exe` | 1.4 MB |
| Windows MSI | `BoomTimer_1.0.0_x64_en-US.msi` | 1.9 MB |

应用未做商业签名（只有 ad-hoc 签名），首次打开时：macOS 需「右键 → 打开」，Windows 点「更多信息 → 仍要运行」。

---

## 效果是怎么做出来的

想让「整个屏幕」抖动，透明浮层是抖不动桌面的。所以引爆瞬间的流程是：

1. 抓一张当前屏幕的快照；
2. 铺一个全屏、无边框、点击穿透、置顶到菜单栏之上的透明窗口；
3. 把快照画进画布，抖的是这张画布 —— 视觉上就是整块屏幕被炸得晃动；
4. 抖完快照淡出，真实桌面回来，烟雾和文案继续飘一会儿。

引爆前有 0.9 秒入场：3D 炸弹按 `1/z` 透视由远及近飞来，带自转、残影拖尾和燃烧的引线（定光源球体着色：本影 + 锐/柔双层高光 + 环境反弹光 + 边缘光）。

叠加的效果层：爆闪 → 冲击波环（环内用快照做折射）→ 火球团块 → 玻璃裂纹 → 火星拖尾 / 燃烧碎屑 / 余烬 → 暖色浓烟 → 提示文案。音效是 WebAudio 实时合成的（低频轰鸣 + 噪声爆裂 + 余震尾巴），不依赖任何音频文件。

浮层**全程点击穿透**，不会打断你正在做的事。

## 功能

- 倒计时预设 15 / 25 / 45 / 60 分钟，或自定义任意分钟数
- 爆完自动重新计时（当番茄钟循环用）
- 爆炸强度三档：温柔 / 标准 / 毁灭
- 炸弹飞来入场（0.9 秒）可关闭，关掉就是零预警直接炸
- 多显示器同时炸（声音只走主屏；副屏自动降一档画质，见下）
- 音效开关 + 音量
- 托盘常驻：关掉窗口倒计时照常跑
- 空格键开始 / 暂停

## macOS 的「屏幕录制」权限

授权后整块屏幕真实抖动；未授权则自动降级——桌面不抖，但压暗背景 + 裂纹 + 火球照常炸。

首次点「试炸」时系统会弹授权框（走 `CGRequestScreenCaptureAccess`）；也可以在 `系统设置 → 隐私与安全性 → 屏幕录制` 里手动勾选 **BoomTimer**。

> 开发模式下运行时，权限会记在**拉起进程的那个 App**（终端 / IDE）名下，列表里看到的不是 BoomTimer —— 这是 macOS TCC 的归属规则，打包后才会以自己的身份和图标出现。

## 开发

```bash
cd tauri && npm install && npm run dev
```

单独调爆炸动画（不用起客户端，浏览器里逐帧看）：

```bash
cd tauri && npm run preview
```

然后打开 `http://localhost:5178/_preview.html`，支持这些参数：

| 参数 | 作用 |
| --- | --- |
| `?i=gentle\|normal\|nuke` | 切换爆炸强度 |
| `?fuse=0` | 跳过入场，直接炸 |
| `?noshot=1` | 模拟「没有屏幕录制权限」的降级效果 |
| `?slow=14` | 时间轴放慢 14 倍 |
| `?manual=1&at=1000` | 跳到第 1000ms 并定格，方便截图比对 |

客户端里也可以用环境变量直接引爆，省得手点：

```bash
BOOM_TEST=3000 ./src-tauri/target/debug/boom-timer
```

## 打包

macOS（在 macOS 上）：

```bash
cd tauri && npx tauri build --target universal-apple-darwin --bundles dmg,app
```

**Windows 包必须在 Windows 上构建**——Rust 编译到 Windows 需要 MSVC 工具链，Tauri 的 WebView2 绑定和 NSIS 打包器也要求 Windows 宿主。`.github/workflows/build.yml` 已经配好：推一个 `v*` tag（或在 Actions 页面手动触发），云端三台机器（Windows / macOS Intel / macOS Apple Silicon）各自构建，安装包自动挂到 Release 上。单次全平台构建约 8 分钟。

```bash
git tag v1.0.0 && git push origin v1.0.0
```

图标由 `scripts/make-icon.js` 纯代码生成（手写 PNG 编码器，不引入任何图形依赖），`npm run icon` 会顺带调 `tauri icon` 转出各平台尺寸。

## 踩过的坑（都在代码注释里标了）

- **截图不能用 xcap**：它走废弃的 `CGWindowListCreateImage`，被新版 macOS 降级成每次调用都重启 ScreenCaptureKit，单屏 2.3 秒。改用系统自带的 `screencapture`，两块屏 0.44 秒。
- **建窗口必须在后台线程**：Tauri 的 `build()` 内部会派发到主线程并阻塞等结果，在主线程闭包里调用直接死锁；反过来原生 objc 调用（设置 NSWindow 层级）又必须在主线程。
- **逻辑像素 / 物理像素**：`inner_size` 收逻辑像素，显示器 API 给物理像素，直接传会在 Retina 上建出两倍大的窗口，爆炸中心飞到屏幕外。
- **别用 DOM 图层做震动**：把全屏截图放在 DOM 里再 transform，合成器每帧都要重新光栅化一个被旋转缩放的全屏图层，WKWebView 上帧率从 60 掉到 20。改成把截图画进画布、用画布变换来抖，恢复 60fps。
- **两个全屏浮层会互抢 GPU**：单屏稳定 60fps，双屏同时跑掉到 20。副屏因此自动降画质（画布像素上限 160 万、粒子数 55%）。
- **音效要在主窗口播**：浮层是点击穿透、从不获得焦点的窗口，WKWebView 不给它放音的权限。音频模块挪到主窗口，浮层通过 IPC 请求代播。
- **Tauri v2 的 capabilities 千万别漏**：手工搭项目（不走 `tauri init`）时最容易漏 `src-tauri/capabilities/default.json`。漏了它，ACL 会默认拒绝 `event:listen`，前端**再也收不到任何后端事件** —— 表现是界面能正确渲染一次、然后彻底不动：时钟停住、按钮不变、设置不生效、音效不响。看起来像「功能没做」，实际是后端一直在跑、界面听不见。而且 ACL 拒绝只体现在一个未捕获的 Promise 拒绝里，不看日志根本发现不了。overlay 窗口是动态命名的，capability 的 `windows` 要写成 `["main", "boom-*"]`。
- **macOS 包必须做 ad-hoc 签名**：TCC 靠代码签名认应用身份，完全没签名的包它**记不住「已允许」**，于是每次抓屏都重新弹一次权限框。在 `tauri.conf.json` 里设 `bundle.macOS.signingIdentity = "-"` 即可，不需要花钱的证书。注意每次重新构建签名哈希都会变，所以更新版本后会再问一次，这是正常的。
- **不能用 `CGPreflightScreenCaptureAccess` 判断权限**：TCC 靠代码签名认应用身份，未签名的包会被这个 API 一律回答 `denied`，即使系统实际放行抓屏。实测 `CGPreflight=denied` 而同时 `实际抓图=true`，导致「请开启权限」的提示永远下不去。判定标准改成真去抓一张 8×8 的小图 —— 以能力为准，不问系统。签名之后这条快路径会自然生效。

## 已知限制

- 应用未做代码签名。
  - macOS：首次打开需「右键 → 打开」；重新打包后签名变化，屏幕录制权限可能要重新授权。
  - Windows：SmartScreen 会拦一次，点「更多信息 → 仍要运行」即可。
- 透明窗口用到了 `macos-private-api`，因此**不能上架 Mac App Store**。
- 抖动期间（约 0.7~1.2 秒）屏幕显示的是快照而非实时画面。点击不受影响，浮层是穿透的。

## 目录

```
tauri/src-tauri/src/main.rs           主进程：计时、托盘、截图、浮层窗口管理
tauri/src-tauri/src/platform.rs       macOS 原生部分：窗口层级、录屏权限
tauri/src-tauri/capabilities/         Tauri ACL 权限声明（漏了它前端收不到事件）
tauri/ui/                             渲染层（bridge.js 把 window.api 映射到 Tauri IPC）
tauri/ui/_preview.html                动画调试页，配合 npm run preview
scripts/make-icon.js                  图标生成（手写 PNG 编码器，无图形依赖）
scripts/preview-server.js             动画调试服务器
.github/workflows/build.yml           云端构建 Windows + macOS 安装包
```
