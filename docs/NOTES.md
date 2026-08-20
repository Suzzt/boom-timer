# 技术笔记

BoomTimer 的实现细节、踩过的坑和发布流程。产品介绍看 [README](../README.md)。

## 技术选型

| | |
| --- | --- |
| 外壳 | [Tauri 2](https://tauri.app)（Rust + 系统 WebView） |
| 主进程 | Rust —— 计时、托盘、屏幕快照、浮层窗口管理 |
| 渲染层 | 原生 HTML / CSS / Canvas 2D，无框架无构建步骤 |
| 音效 | WebAudio 实时合成，不含任何音频文件 |
| 图标 | `scripts/make-icon.js` 纯代码生成（手写 PNG 编码器，零图形依赖） |

安装包 1.4~2.6 MB，装完 5.5 MB。同样的功能用 Electron 实现是 91~95 MB 安装包、230 MB 占用 —— 差距全部来自「自带 Chromium」还是「用系统 WebView」。

## 「整块屏幕震动」是怎么做的

透明浮层是抖不动桌面的，所以引爆瞬间的流程是：

1. 抓一张当前屏幕的快照；
2. 铺一个全屏、无边框、点击穿透、置顶到菜单栏之上的透明窗口；
3. 把快照**画进画布**，抖的是这张画布 —— 视觉上就是整块屏幕被炸得晃动；
4. 抖完快照淡出，真实桌面回来，烟雾和文案继续飘一会儿。

## 爆炸效果的图层

引爆前 0.9 秒入场：3D 炸弹按 `1/z` 透视由远及近飞来，带自转、残影拖尾和燃烧的引线。球体是定光源着色 —— 本影 + 锐/柔双层高光 + 右下环境反弹光 + 边缘光。

引爆后按顺序叠加：

爆闪 → 冲击波环（环内用屏幕快照做折射，才有「压过去」的实感）→ 火球团块（9 个偏移团块叠加，避免「一个圆」的廉价感）→ 玻璃裂纹（放射状带分叉，先画在火球下面，中心才会被火光盖住）→ 火星拖尾 → 燃烧碎屑 → 上飘余烬 → 暖色浓烟（早期被火球烤成暖色，后期转冷灰）→ 提示文案。

## 踩过的坑

按踩到的顺序，每条都在代码里留了注释。

### Tauri v2 的 capabilities 千万别漏

手工搭项目（不走 `tauri init`）时最容易漏 `src-tauri/capabilities/default.json`。漏了它，ACL 会默认拒绝 `event:listen`，前端**再也收不到任何后端事件** —— 表现是界面能正确渲染一次、然后彻底不动：时钟停住、按钮不变、设置不生效、音效不响。

看起来像「功能没做」，实际是后端一直在跑、界面听不见。而且 ACL 拒绝只体现在一个未捕获的 Promise 拒绝里，不看日志根本发现不了。

浮层窗口是动态命名的，capability 的 `windows` 要写成 `["main", "boom-*"]`。

### macOS 包必须做 ad-hoc 签名

TCC（隐私权限系统）靠代码签名认应用身份，完全没签名的包它**记不住「已允许」**，于是每次抓屏都重新弹一次权限框。在 `tauri.conf.json` 里设 `bundle.macOS.signingIdentity = "-"` 即可，不需要花钱的证书。

注意每次重新构建签名哈希都会变，所以更新版本后会再问一次授权，这是正常的。

### 不能用 `CGPreflightScreenCaptureAccess` 判断权限

同样是签名问题的延伸：未签名（或 ad-hoc 签名）的包会被这个查询 API 一律回答 `denied`，即使系统实际放行抓屏。实测日志里出现过 `CGPreflight=denied` 与 `实际抓图=true` 并列。

后果是「请开启权限」的提示永远下不去，重启也没用。判定标准改成**真去抓一张 8×8 的小图** —— 以能力为准，不问系统。哪天做了商业签名，这条快路径会自然生效。

另外权限探测**不能定时轮询**：每次探测都会拉起 `screencapture` 子进程，未授权时系统会弹框，轮询就变成没完没了的弹窗骚扰。只在启动时探一次，之后靠窗口获得焦点触发（并限制最短间隔 20 秒）。

### 截图不能用 xcap

`xcap` 走的是废弃的 `CGWindowListCreateImage`，被新版 macOS 降级成每次调用都重启一遍 ScreenCaptureKit，**单屏就要 2.3 秒**（两块屏 4.6 秒），完全破坏「突然炸开」的手感。

改用系统自带的 `/usr/sbin/screencapture`（走现代路径），两块屏并行 **0.44 秒**。抓完校验图片尺寸，防止显示器索引对不上。Windows 端不受影响，仍用 xcap。

### 建窗口必须在后台线程，原生调用必须在主线程

Tauri 的 `WebviewWindowBuilder::build()` 内部会派发到主线程并阻塞等结果 —— 在 `run_on_main_thread` 的闭包里调用会**直接死锁**（第一个窗口建完就卡住）。

反过来，设置 NSWindow 层级的那段 objc 调用又必须在主线程，否则 AppKit 直接 SIGILL。

结论：建窗口留在后台线程，只把 objc 那一步用 `run_on_main_thread` 切回去。

显示器信息也别用 Tauri 的 API —— 主线程调用会死锁，后台线程调用返回的 `scale_factor` 是错的（退化成 1）。统一改用 `xcap::Monitor::all()`，它不依赖事件循环，任何线程都能安全调用。注意它的坐标语义分平台：macOS 给逻辑点，Windows 给物理像素。

### 逻辑像素 / 物理像素

`inner_size` 收的是逻辑像素，显示器 API 给的是物理像素。直接传会在 Retina 上建出**两倍大**的窗口，爆炸中心飞到屏幕外，屏幕上什么都看不到。

### 别用 DOM 图层做震动

最初把全屏截图放在 DOM 的 `<img>` 里，再对容器做 `transform`。结果 WKWebView 上帧率从 60 掉到 20 —— 合成器每帧都要重新光栅化一个被旋转缩放的全屏图层。

定位过程值得一记：先做逐段耗时埋点，发现**绘制只占 3%**（96 帧总共 113ms），瓶颈根本不在画布；再看帧间隔，中位数 17ms（正好 60fps）但前 0.6~1 秒全是长卡顿，时间点和震动阶段完全吻合。

改成把截图、爆闪、提示文案**全部画进画布**、用画布变换来抖之后，DOM 里再没有任何每帧变化的图层。`#stage` 上那句 `will-change: transform` 也要删掉 —— 它会白占一个合成层。

### 真正的瓶颈是画布像素数

DOM 图层消掉之后仍有 26% 的帧超过 20ms。埋点显示 JS 绘制只有 **0.86ms/帧**，全屏截图那次 `drawImage` 整场加起来才 1ms —— 开销全在浏览器每帧把画布合成到全屏透明窗口这一步，而它随**画布像素数**增长。

同一台机器上扫一遍画布分辨率：

| 画布像素 | 掉帧率(>20ms) | p90 |
| --- | --- | --- |
| 4.0 MP | 26% | 32 ms |
| 3.0 MP | 15% | 24 ms |
| 2.0 MP（DPR 1.0） | 11% | 22 ms |
| **1.6 MP** | **4%** | **18 ms** |
| 1.2 MP | 2% | 18 ms |

拐点在 1.6 MP，对应 DPR≈0.89，比 1:1 只小一成，肉眼分辨不出。**超采样（DPR>1）对全是柔和渐变的爆炸毫无收益**，纯属白烧 GPU。

### canvas 的 shadowBlur 极贵

提示文案挪进画布后，JS 绘制从 0.86ms/帧 暴涨到 **9.8ms/帧** —— 带发光的文字每帧重画一次，`shadowBlur` 就是主凶。预渲染成一张精灵图、每帧只 `drawImage`，立刻回到 1.1ms/帧。

任何每帧都要画、又带 shadow / 大面积渐变的东西，都该先预渲染。

### 逐帧 rand() 会伪装成掉帧

震动原来写的是 `(sin(...) + 0.6*sin(...)) * amp * rand(0.75, 1.15)`。那个逐帧随机是高频噪声，**哪怕稳定 60fps，看着也像在掉帧**。

换成三个不同频率的正弦叠加：混乱感保留，但运动连续可导，观感明显更顺。引线阶段的紧张微抖同理。

### 多显示器的代价省不掉

两块屏同时炸时，用户正在看的那块屏掉帧率从 8% 涨到 14%（p99 从 33ms 涨到 50ms）。副屏限到 30fps、分辨率压到 0.5MP 都救不回来 —— 代价来自「存在第二个全屏透明窗口需要被合成」本身，是 WindowServer 层面的开销，应用内优化不掉。

所以多屏改成**默认关闭**，设置里保留开关，并在界面上注明会让主屏帧率略降。

### 音效要在主窗口播

浮层是点击穿透、从不获得焦点的窗口，WKWebView 不给这种窗口放音的权限。音频模块挪到主窗口（用户点过，AudioContext 一旦解锁就长期有效），浮层通过 IPC 请求代播。

## 目录

```
src-tauri/src/main.rs           主进程：计时、托盘、截图、浮层窗口管理
src-tauri/src/platform.rs       macOS 原生部分：窗口层级、录屏权限
src-tauri/capabilities/         Tauri ACL 权限声明
ui/                             渲染层（bridge.js 把 window.api 映射到 Tauri IPC）
ui/_preview.html                动画调试页，配合 npm run preview
ui/_ui-shot.html                把控制台界面导出成图片（README 配图用）
scripts/make-icon.js            图标生成
scripts/preview-server.js       动画调试服务器（含 /save 导图端点）
.github/workflows/build.yml     云端构建 Windows + macOS 安装包
```

## 调试

动画可以脱离客户端单独调，`npm run preview` 后打开 `http://localhost:5178/_preview.html`：

| 参数 | 作用 |
| --- | --- |
| `?i=gentle\|normal\|nuke` | 切换爆炸强度 |
| `?fuse=0` | 跳过入场，直接炸 |
| `?noshot=1` | 模拟「没有屏幕录制权限」的降级效果 |
| `?slow=14` | 时间轴放慢 14 倍 |
| `?manual=1&at=1145` | 跳到第 1145ms 并定格 |
| `?manual=1&at=1145&save=名字` | 定格并把这一帧导出到 `assets/` |

客户端里也有两个环境变量开关：

```bash
BOOM_TEST=3000    ./src-tauri/target/debug/boom-timer  # 启动 3 秒后自动引爆
BOOM_DEBUG=1      ./src-tauri/target/debug/boom-timer  # 把诊断日志写到缓存目录
BOOM_MAXPX=1.6e6  ./src-tauri/target/debug/boom-timer  # 覆盖画布像素上限，用来扫性能拐点
```

`BOOM_DEBUG` 打开后，每次爆炸结束会往日志里写一行帧时统计：

```
[perf] 主屏 画布1600x1000 帧数=196 中位=17.0 p90=19.0 p99=33.0 最大=50.0 掉帧(>20ms)=16(8%) JS绘制=1.10ms/帧
```

改动渲染层之后跑三轮对比这行，比肉眼判断可靠得多。

`BOOM_DEBUG` 值得保留 —— 前端一旦静默出错（比如上面那个 ACL 问题），没有这条通道就只能靠猜。

## 打包发布

macOS 本地打包：

```bash
npm run icon    # 重新生成图标（改过图标才需要）
npx tauri build --target universal-apple-darwin --bundles dmg,app
```

**Windows 包必须在 Windows 上构建** —— Rust 编译到 Windows 需要 MSVC 工具链，Tauri 的 WebView2 绑定和 NSIS 打包器也要求 Windows 宿主。`.github/workflows/build.yml` 已经配好，推一个 `v*` tag 即可：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

云端三台机器（Windows / macOS Intel / macOS Apple Silicon）各自构建，安装包自动挂到 Release。单次全平台约 8 分钟。

> workflow 里写了 `if-no-files-found: warn`，意味着**产物为空也算成功**。每次发布后建议把安装包下载下来核对一下真实体积，别被绿勾骗了。

## 已知限制

- 没有「免打扰时段」和「投屏自动静音」，开会前得手动暂停。
- 应用只有 ad-hoc 签名，首次打开需要绕过系统拦截。
- 透明窗口用到了 `macos-private-api`，因此**不能上架 Mac App Store**。
- 抖动期间（约 0.7~1.2 秒）屏幕显示的是快照而非实时画面。
