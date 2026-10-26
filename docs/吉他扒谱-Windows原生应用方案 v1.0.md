# 吉他扒谱 · Windows 原生应用方案（v1.0）

> **定位**：把 `app/`（Vite + React 18 + TypeScript 纯前端）封装为 **Windows 原生桌面应用**（安装即用、离线运行、双击打开）。本方案是 v4.1《细化方案》§1.4「外壳 spike」的全面展开与落地文档——v4.1 定了"要不要原生壳、怎么选型"，本文定"Windows 上具体做什么、怎么验收、怎么发布"。
>
> **文档关系**：v4.0 = 产品愿景；v4.1 = 工程细化（pipeline / Viterbi / Step 4 执行规格）；**本文 = Windows 原生化专案**。本文不推翻 v4.1 任何决策，只展开。与 v4.1 重叠处（spike 验收、`.agtp`、sidecar、BYOK）引用原文不重复。
>
> 事实核查时间：2026-10-25（联网核实，见附录 A）。

---

## 0. 目标 / 非目标 / 结论摘要

**目标（原生 Windows 应用要什么）**

| # | 能力 | 现状（纯前端） | 原生化后 |
| :--- | :--- | :--- | :--- |
| N1 | 安装与启动：双击安装包 → 开始菜单/桌面图标 → 双击运行，无浏览器地址栏 | ❌ 起本地 dev server 或开网页 | ✅ NSIS 安装器 + 独立 exe |
| N2 | 完全离线运行 | ⚠️ 依赖网络加载页面（本体资源已本地，但形态是网页） | ✅ 全部资源打进安装包 |
| N3 | 持久化到文件系统（`.agtp/` 工程目录，v4.1 §2.2） | ❌ 停留在 localStorage/IndexedDB，重装即失 | ✅ `%APPDATA%` + 用户目录 |
| N4 | 文件关联：双击 `.agtp` 直接打开应用并载入 | ❌ | ✅ 注册表关联 |
| N5 | 拖拽/打开本地音频（已有 AudioDropzone） | ✅ 浏览器可用 | ✅ 需在壳内复验 |
| N6 | Sidecar 进程：spawn demucs.cpp（Step 4 分轨） | ❌ 浏览器无法起进程 | ✅ 原生进程 + 流式进度 |
| N7 | BYOK 主进程代理：密钥不进前端、统一脱敏日志 | ⚠️ 面板与直连客户端已有（`llmClient.ts`），代理属二期切换 | ✅ Rust 侧代理 |
| N8 | 密钥安全存储（Windows 凭据管理器） | ❌ | ✅ |
| N9 | 自动更新 | ❌ | ✅ 应用内检查 + 一键升级 |
| N10 | 应用日志 + 崩溃检测 + 诊断包导出（§5.4） | ❌ console 而已 | ✅ 落盘 `%APPDATA%\logs` + 一键 zip 反馈 |

> 注：N 表描述**最终态**；零改动约束（§3.3）下首版部分能力降级兑现——N3 用 WebView2 持久化存储、N4 只启动不自动载入、N8/N10 部分兑现——逐项见 §3.3 兑现矩阵。

**非目标**

- macOS / Linux 版（Tauri 天然可扩，但本文只锁定 Windows；跨平台列 §12 开放问题）
- 微软商店上架（MSIX）——updater 不支持 MSIX，且商店审核与本产品迭代节奏不匹配，不做（§8.1）
- 安卓端——**已定：另行用独立 md 设计，本文不做**。本文所有决策只按 Windows 桌面最优解做，不为移动端妥协；但 §3.3 适配层（platform.ts 能力出口化）同时是未来安卓壳的复用基础，出口签名设计为平台无关。
- 自定义自绘标题栏——v1 保留 Windows 原生标题栏（深浅色跟随即可），自绘列二期美化项

**结论摘要（先给答案）**

1. **外壳：Tauri 2.12**（2026-09 发布的 2.x 最新大版本）+ Evergreen WebView2。Electron 仅作 spike 硬伤回落（决策规则沿用 v4.1 §1.4）。
2. **安装器：NSIS（.exe）**，`currentUser` 安装（免 UAC、装到 `%LOCALAPPDATA%\Programs`）。MSI/MSIX 不做；另发一个 **portable 绿色 zip** 作为次要分发。
3. **更新：tauri-plugin-updater + minisign 签名**（强制、免费、必须做）+ GitHub Releases 托管 `latest.json`。只发 NSIS 一种格式，避免 NSIS/MSI 混装把更新装错的已知坑。
4. **代码签名（Authenticode）：v1.0 先不签**（开源免费软件，README 引导用户过 SmartScreen）；用户量起来后上 **Azure Artifact Signing**（原 Trusted Signing，Basic 档 $9.99/月，个人开发者可入驻）。注意它与更新签名（minisign）是两回事。
5. **CI**：GitHub Actions `windows-latest` + `tauri-action`，推 tag → 构建签名 → Draft Release。
6. **架构**：x64 主线；Windows ARM64（`aarch64-pc-windows-msvc` 交叉编译已可行）列二期可选。
7. **性能分层（用户硬要求：性能最大化）**：重计算走原生（sidecar 进程 / Rust）；WebView 内计算的优化分"壳侧手段"（防后台节流等，本方案立即执行）与"前端侧机会"（Worker 化/SIMD，二期）；实测不达标时逃生舱是"**计算下沉 Rust**"而不是 UI 重写——见 §2 前提与 §3.4。
8. **零改动迁移（用户拍板的第一约束）**：`app/` 整体冻结——**不修改、不新增、不删除**；壳工程放仓库根 `src-tauri/`（不在 app/ 内），工具链零侵入（不给 package.json 加任何依赖或脚本）；能力按"零改动即得 / 壳侧储备 / 二期前端配合"三档兑现（§3.3 矩阵），并用 `git diff -- app/` 为空 + 构建产物 hash 一致做**机器验证**（W15）。

---

## 1. 现状盘点与差距

### 1.1 现状（截至 2026-10）

- 形态：纯前端 Vite 应用，`npm run dev` 起本地服务。v4.1 §1.4 已定"纯前端 Vite 随 Step 4 退出"——指**发布形态**退出（不再以网页为交付物），Vite 本身保留，成为桌面壳 `tauri build` 的前端构建步骤。
- 持久化（2026-10-25 代码已核实）：界面偏好经 `settings.tsx` 存 **localStorage**（单一 STORAGE_KEY + zod 校验）；**BYOK API Key 仅会话内存、绝不落盘**（`copilot.tsx` / `SettingsModal.tsx` 注释明确，刷新即清除）；**IndexedDB 未使用**；`.agtp/` 工程持久化（v4.1 §2.2）尚未落地。
- 已有可复用资产：BYOK 连接面板、练习模式、AudioDropzone 拖拽、波形网格 overlay、alphaTab 渲染/播放——这些 UI **零改动**入壳（v4.1 §1.4 spike 第 5 项验收）。
- Step 4 依赖（sidecar / 主进程 fetch / keychain）在浏览器里**不可能**做——这正是原生壳的全部理由。

### 1.2 差距清单（要补的东西）

| 差距 | 归属章节 |
| :--- | :--- |
| src-tauri/ 壳工程与构建链 | §3 |
| 零改动边界与能力兑现矩阵（前端不动，壳侧消化） | §3.3 |
| 数据持久化：零改动现状（WebView2 持久化）与目标态（`.agtp` 文件化） | §5 |
| 文件关联 + 双击打开 | §4.3 |
| sidecar spawn/杀树/进度流 | §6 |
| BYOK 代理 + 凭据管理器 | §7 |
| 安装器/签名/更新/CI | §8 |
| Windows 专项测试矩阵 | §10 |

---

## 2. 外壳选型：Tauri 2 vs Electron

**先回答一个前提问题：要不要重写成 WinUI 3 / WPF / Qt 这类"纯原生" UI？——不要。**

"Windows 原生应用"的判定标准是**形态与能力**（独立进程、安装器、文件关联、离线运行、可起子进程、系统 API 访问），不是 UI 框架出身。重写意味着丢弃全部 React 前端资产，换来 **0 性能收益**——本产品的性能瓶颈在**音频推理与分轨**（CPU/GPU 密集），这部分本来就跑在原生侧（sidecar 进程 / Rust，见 §3.4），UI 只做渲染交互，WebView 渲染谱面这类文档型界面绰绰有余。若未来实测 WebView 内某段计算不达标，逃生舱是"**计算下沉 Rust**"（§3.4 P5），而不是"UI 重写"。

### 2.1 对比（Windows 桌面场景）

| 维度 | Tauri 2.12 | Electron（同期） |
| :--- | :--- | :--- |
| 渲染引擎 | 系统 WebView2（Win11 全预装；Win10 2004+ 自 2023-01 起随 Windows Update 分发） | 自带完整 Chromium |
| 安装包体积 | 预期 10~20MB（含 alphaTab 字体 + sonivox 音源；不含 AI 模型） | 通常 60~100MB |
| 安装后占用 | 数十 MB 级 | 200~400MB 级 |
| 内存 | 略优（无内嵌 Node 运行时），但 WebView2 本身也是 Chromium——**优势存在、不悬殊** | 基线 |
| 主进程语言 | Rust（学习成本；本项目主进程代码量很小，见 §3.3） | Node/JS（团队熟悉） |
| 起进程（sidecar） | 原生支持 externalBin + `new_sidecar` | `child_process`，成熟 |
| 自动更新 | 官方 updater 插件 + minisign | electron-updater，成熟 |
| 安全默认值 | 权限系统（capabilities）默认收紧 | 默认全开，需自行收紧 |
| 生态/踩坑资料 | 较少但在增长 | 极多 |

### 2.2 决策

沿用 v4.1 §1.4 的 spike 决策规则：**六项验收（体积/spawn/keychain/主进程 fetch/前端零改动/开发体验）全过 → Tauri；出现硬伤 → 回落 Electron**。

"硬伤"的界定（防止摇摆）：

- 前端核心功能（alphaTab 渲染/播放、Web Audio、WASM 推理、拖拽、打印）在 WebView2 中不工作且无 workaround；
- Rust 构建链在团队环境反复跑不通且无法固定；
- 关键插件（updater / fs / dialog）存在影响本产品的已知缺陷。

以下**不算**硬伤：安装包比预期大几 MB、要学 Rust 基础语法、WebView2 需引导个别老机器安装。

### 2.3 WebView2 运行时策略

- **Evergreen（跟系统自动升级）**为准——个别老 Win10（<2004 或长期不更新）缺失时，由 NSIS 安装器的 `webviewInstallMode` 处理，三选项：
  - `downloadBootstrapper`（默认）：安装时联网下 ~2MB 引导器按需装运行时——**取默认**；
  - `embedBootstrapper`：引导器内嵌，离线机器上引导器也下载不了运行时，意义有限；
  - `offlineInstaller`：内嵌 ~150MB 全量离线安装器——安装包暴涨，**不内嵌**，另在 Release 页手动提供"离线完整包"给无网用户。
- 不钉版本（Fixed Version 需捆绑 ~200MB 且失去安全更新），接受 Evergreen 自动升级带来的理论回归风险（§12 风险表）。

---

## 3. 工程接入（Tauri 2.12）

### 3.1 目录与工具链（壳工程在 app/ 之外）

```
Guitar/
├── docs/
├── app/                    # 既有前端 —— 整体冻结（§3.3 零改动原则：不改/不增/不删）
├── src-tauri/              # 新增壳工程（tauri 2.12），位于仓库根，不在 app/ 内
│   ├── src/main.rs         # 入口：插件注册/单实例/崩溃标记/--diagnostics/更新检查
│   ├── src/commands.rs     # 全部 IPC command（四类储备 + 壳侧辅助）
│   ├── binaries/           # sidecar（§6，M3 放入）
│   ├── capabilities/       # Tauri 2 权限（最小化，§9）
│   ├── keys/               # minisign 更新签名钥（私钥 gitignore，§8.3）
│   ├── scripts/            # msvc.cmd 包装 / check-versions.sh / make-icon.ps1
│   ├── qa/                 # W15 本机哈希基线（app-baseline / dist-baseline）
│   ├── icons/              # icon.ico（多尺寸）+ png
│   ├── tauri.conf.json
│   └── Cargo.toml
└── .github/workflows/release-windows.yml   # CI（§8.5）
```

- 工具链：Rust（MSVC target）+ rustup + VS Build Tools（C++ 工作负载）+ Node/npm；Tauri CLI 一律经 `npx @tauri-apps/cli` 调用（CI 走 tauri-action）——**不给 app/package.json 添加任何依赖或脚本**。`rustc -Vv` 的 `host:` 即 sidecar 命名所需 target triple。
- **Windows + Git Bash 环境注意（已落地为 `src-tauri/scripts/msvc.cmd` 包装）**：Git Bash 的 `/usr/bin/link`（coreutils）会遮蔽 MSVC link.exe，cargo 报 `link: extra operand`——本地一切构建/开发命令走包装：`cd src-tauri && scripts/msvc.cmd npx @tauri-apps/cli dev`（自动拉起 app/ 的 Vite，热更新保留）；构建同理 `... build`。CI（windows-latest，pwsh/bash）不受此遮蔽影响，无需也不应套用该包装。建议本地 npx 固定 CLI 次版本、与 CI 的 tauri-action 所带版本对齐，避免 CLI 漂移造成本地/CI 构建差异。
- devUrl 锁 5173，端口被占时 Vite 会自动换端口导致壳连不上——开发时保持 5173 空闲即可（不改 vite 配置来"修复"）。
- **前端构建产物零分叉**：`frontendDist` 指向 app/ 的 Vite `build.outDir`，不为桌面单独打一份、不打两份配置。

### 3.2 tauri.conf.json 骨架（关键字段示意）

```jsonc
{
  "build": {
    "frontendDist": "../app/dist",                          // 直接消费既有产物（零分叉）
    "devUrl": "http://localhost:5173",                      // 既有 dev server——壳适配前端
    "beforeDevCommand": "npm --prefix ../app run dev",
    "beforeBuildCommand": "npm --prefix ../app run build"   // 与直接构建完全同一条命令（W15② 的前提）
  },
  "productName": "AI 智能扒谱",          // 安装器/开始菜单显示名（中文可）
  "identifier": "com.dsh.guitar",        // 决定 %APPDATA% 目录名，上线前定死不再改
  "app": {
    "windows": [{ "width": 1280, "height": 800, "minWidth": 1024, "minHeight": 680 }],
    // CSP 以前端现状实测为准、宁松勿破——壳适配前端，而不是让前端迁就 CSP（§9）
    "security": { "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https: ipc: http://ipc.localhost" }
  },
  "bundle": {
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"],
    "externalBin": ["binaries/demucs"],                 // §6
    "fileAssociations": [{ "ext": ["agtp"], ... }],     // §4.3
    "windows": { "nsis": { "installMode": "currentUser", "languages": ["SimpChinese", "English"] } }
  },
  "plugins": { "updater": { "pubkey": "<minisign 公钥>" } }
}
```

### 3.3 零改动迁移原则（本方案第一约束，用户拍板）

**硬规则：`app/` 目录整体冻结——不修改、不新增、不删除任何文件（一个 ts 文件都不加、一行配置都不动）。所有原生化工程量只发生在 `app/` 之外**（仓库根的 `src-tauri/`、`.github/`、docs）。总纲一句话：**壳适配前端，而不是前端适配壳**——任何"需要前端配合"的点，要么在壳侧消化，要么降级/推迟，绝不回头改前端。

配套纪律：

- 工具链零侵入：Tauri CLI 用 `cargo install tauri-cli` / `npx` 调用，不向 `app/package.json` 加依赖与脚本；devUrl、构建命令全部在 tauri.conf.json 里指向既有 npm scripts（§3.2）。
- CSP 等壳侧配置向前端现状让步（宁松勿破，§3.2）。
- `index.html` 不注入任何脚本（IPC 由壳自动注入，前端无需感知、无需读取）。

**能力兑现矩阵（零改动版的真实预期，逐项说清，不装糊涂）**：

| §0 能力 | 零改动兑现度 | 说明 |
| :--- | :--- | :--- |
| N1 安装启动 / N2 离线 / N9 自动更新 | ✅ 完整 | 纯壳侧 |
| N5 拖拽与音频 | ✅ 完整 | 现有 AudioDropzone / Web Audio / WASM 在 WebView2 原样工作 |
| N3 持久化 | ⚠️ 降级可用 | 现状前端的 localStorage（IndexedDB 未使用）在 WebView2 内**原样工作且持久**（`%LOCALAPPDATA%\com.dsh.guitar\EBWebView\`，卸载保留）——桌面版零改动也有持久化；`.agtp` 文件化（§5.1 目标态）需前端读写代码 → 二期 |
| N4 文件关联 | ⚠️ 部分 | 双击 `.agtp` 能启动并聚焦（§4.3）；**自动载入工程需前端读启动参数 → 二期**（壳先把路径暂存，届时即插即用） |
| N6 sidecar / N7 BYOK 代理 | ✅ 壳侧就绪 | 分轨在前端无现状调用方（无东西可破坏）；LLM 已有**直连 fetch** 客户端（`llmClient.ts` + 测试），零改动下在 WebView2 内原样可用；壳把 spawn/代理备好，前端切换代理/接入分轨属 Step 4 已规划范畴、届时另行批准 |
| N8 凭据管理器 | ⚠️ 二期 | 现状 BYOK Key **仅会话内存、绝不落盘**（代码已核实）——零改动下桌面版每次启动需重填 Key（非持久，但零泄密面）；壳侧凭据 command 先备好，且前端源码注释（`copilot.tsx` / `settings.tsx`「装壳后走 OS keychain」）已自我规划同方向 |
| N10 日志/崩溃 | ⚠️ 壳侧部分 | 壳进程日志 + 崩溃标记 + 原生对话框 + 诊断包（§5.4）；捕获前端 console 需前端初始化 → 二期 |
| 窗口记忆 / 任务栏进度 / 防休眠 | ✅ 完整 | 纯壳侧 |

**前端机会清单（移交前端项目；本方案一律不动，二期经用户逐项批准后实施）**：

- platform 适配层（`app/src/platform/`：storage/secrets/net/spawn 出口化、isTauri 分流——同时是安卓壳的复用基础，安卓文档设计时可沿用此出口签名；前端源码注释已规划同方向：「装壳后整体改为主进程代理 + OS keychain」(`copilot.tsx`)，二期实施直接对齐、无认知冲突）；
- `.agtp` 工程读写、设置导出/导入 JSON、双击 `.agtp` 自动载入、前端 error boundary、editOverlay 自动保存、前端 console 接管进日志；
- §3.4 前端侧性能机会（Worker 化、SIMD 后端锁定、启动懒加载、basic-pitch 下沉 Rust）。

**零改动的可机器验证（本方案第一验收，W15）**：

1. 迁移分支上 `git diff <迁移前基线> -- app/` 输出为空（不修改、不新增、不删除，一条命令证明）；
2. 同一 commit 下，`app/` 直接 `npm run build` 的产物 hash == `cargo tauri build` 内部执行**同一条 npm 命令**的产物 hash——**装进安装器的就是你测过的那份前端，一个比特都不差**。

主进程 Rust 侧代码量刻意压小：fetch 代理、凭据读写、spawn 转发、路径查询四类 command，全部作为**储备**先就位（前端二期接入时即插即用），其余逻辑维持在前端。

### 3.4 性能工程（"性能最大化"的落点）

> 本产品性能分层：**重计算（分轨）在原生 sidecar 进程**——与 UI 框架无关，天生原生速度；**中计算（轻量档转写 / Viterbi / 量化 / onset）在 WebView 内**；**渲染（谱面/波形）在 WebView 内**——文档型 UI，WebView 足够。
> 零改动约束下，性能手段分两档：**壳侧（本方案立即执行）**与**前端侧（机会清单，二期另行批准）**。

**壳侧手段（本方案执行，前端零改动）**：

| # | 手段 | 说明 |
| :--- | :--- | :--- |
| P1 | 硬件加速确认 | WebView2 GPU 合成默认开启，不做显式开关（关了只有坏处）；W6 验证 WebGL 推理正常即为生效 |
| P2 | `additionalBrowserArgs` 防节流 | 追加 `--disable-background-timer-throttling --disable-renderer-backgrounding`：窗口最小化/失焦时前端推理与调度不被 Chromium 节流。**注意该字段整体替换默认参数**——必须保留官方默认 flag（`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` 等），只做追加 |
| P7 | 内存（壳侧部分） | 壳进程自身 footprint 控制；日志按日轮转 7 天封顶。长曲分段（v4.1 §3.2）与 `.agtp` debounce 属前端/数据层设计，维持原文档不变 |
| P8 | 任务栏进度 | 分轨等长任务由**壳侧** Rust 直接调 `setProgressBar`（进度来自 sidecar 事件，不经前端）——窗口最小化时任务栏可见进度条，与 §6.3 防休眠配套 |

**前端侧机会（§3.3 移交清单，本方案不动前端）**：

| # | 机会 | 说明 |
| :--- | :--- | :--- |
| P3 | Worker 化 | CPU 阶段（basic-pitch 推理、Viterbi、量化、onset、解码）进 Web Worker，主线程只留 UI——改的是前端代码结构，二期 |
| P4 | WASM SIMD / 多线程 | tfjs WASM / ort-web 的 SIMD(+threads) 后端启动探测并锁定——前端构建结构，二期 |
| P5 | 原生逃生舱 | ① demucs.cpp 已原生（壳侧，M3）；② WebView 内 basic-pitch 若实测不达标（对照 v4.1 §1.2 基线），迁 ONNX Runtime 到 Rust 侧（ort crate，SIMD+线程池）——涉及前端调用方式，二期；③ 大文件解码迁 Rust（symphonia）同上 |
| P6 | 启动性能 | 重型面板/音源字体 lazy import、首屏不碰模型文件——前端构建结构，二期；壳侧只保证 Rust 初始化不阻塞启动路径 |

> fps 门禁（§10）在零改动下是**迁移质量指标**而非改前端的理由：同一前端在 WebView2 内不得显著差于 Chrome 直开；若差，先查壳侧（P1/P2/GPU），查完确属前端自身瓶颈则记录移交（P3~P6），仍然不改。

---

## 4. 窗口与系统集成

### 4.1 窗口

- 默认 1280×800，最小 1024×680（TabViewer + 波形双栏的下限）。
- 窗口几何记忆（tauri-plugin-window-state）：记住大小/位置/是否最大化——桌面应用的基本预期，缺失会被用户当成"网页套壳"。
- 深浅色：前端已是 CSS 变量双主题，WebView2 内 `prefers-color-scheme` 生效，标题栏 `theme` 跟随系统——**验收点：系统切换深浅色，标题栏与页面同步切换**。
- 高 DPI：WebView2 按 per-monitor 感知渲染；**验收点：150% 缩放下无模糊、无错位**（§10）。

### 4.2 单实例与打开行为

- `tauri-plugin-single-instance`：二次启动聚焦已有窗口，并把启动参数（如双击的文件路径）转给首实例。
- 「文件 → 打开」「最近文件」菜单由前端 HeaderBar 自行实现（不依赖原生菜单）；v1 不做原生菜单栏。

### 4.3 文件关联

- v1 **只关联 `.agtp`**（工程文件，v4.1 §2.2）。音频格式（wav/mp3/m4a…）**不关联**——抢占系统默认播放器是用户最反感的安装器行为，音频一律走拖拽/文件选择器；`.gp`/`.mid`/`.musicxml` 同理不抢。
- `bundle.fileAssociations` 声明 ext/description/icon/role；双击 `.agtp` → 启动应用 → 单实例聚焦已开实例。**零改动边界**：自动载入该工程需前端读取启动参数，列二期；壳侧先把路径暂存（`%APPDATA%\pending-open.json`），前端二期接入时即插即用。安装器写入注册表、卸载时清理。
- deep link（`agtp://` 协议）：二期可选，v1 无场景（无云端分享链路）。

### 4.4 打印（PDF 导出路径保留）

alphaTab 的 PDF 导出 = 浏览器打印（v4.1 §2.2 已定）。WebView2 支持 `window.print()` 并弹系统打印对话框（含"另存为 PDF"）。**验收点：WebView2 内打印预览正常、输出 PDF 字体（乐谱字体）嵌入正常。**

### 4.5 音频行为（练习场景专项）

音频是本产品体验与性能的隐性主战场（练琴场景对精度和连续性敏感）。WebView2 使用与 Edge 同源的媒体栈（WASAPI 共享模式）：

- **格式矩阵（已核实）**：WAV / MP3 / FLAC / OGG(Vorbis) / Opus 为开源编解码、原生支持；**AAC/m4a 依赖 Edge 携带的授权编解码器，WebView2 内开箱可用**（开源 Chromium 单独编译没有，WebView2 有——这是选 WebView2 而非自编译 Chromium 的隐性红利之一）。验收见 W11。
- **定时精度**：节拍器 / A-B 循环 / 播放光标的调度应走 audioWorklet / lookahead 而非 setInterval 直推（练琴场景 ±10ms 级可感）。**零改动边界**：本方案只做验收观察与记录，发现不达标作为缺陷移交前端项目另行修复，不在迁移中整改。
- **延迟**：AudioContext `latencyHint: 'interactive'`；Web Audio graph 保持扁平，不加无谓节点。
- **设备热切换**：监听 `devicechange`（拔插耳机 / 换声卡）→ 挂起重建 AudioContext 后继续播，不许静音卡死——验收 W12。

### 4.6 不做清单

原生托盘、系统通知、原生右键菜单、全局快捷键——v1 全不做。练习模式（节拍器/A-B 循环）是窗口内功能，不需要后台驻留；这些都留给二期按需加。

---

## 5. 数据持久化改造（浏览器 → 文件系统）

### 5.1 路径决策表（对齐 v4.1 §2.2）

> **零改动现状**：现状前端的界面偏好存 localStorage（`settings.tsx`，IndexedDB 未使用），在 WebView2 内**原样工作且持久**（数据落在 `%LOCALAPPDATA%\com.dsh.guitar\EBWebView\`，卸载保留）——桌面版零改动也有持久化，只是文件形态要等二期。下表为**目标态设计**（二期前端配合后实施），本方案立此存照、不现在落地；唯一例外是壳侧日志（tauri-plugin-log），M1 即生效。

| 数据 | 位置 | 说明 |
| :--- | :--- | :--- |
| 应用设置（主题/默认调弦/性能档…） | `%APPDATA%\com.dsh.guitar\settings.json` | tauri-plugin-store |
| `.agtp/` 工程目录（transcript/editOverlay/谱面…） | 用户自选目录（默认 `文档\AI扒谱\`） | v4.1 §2.2 结构，一字不改 |
| 最近文件/谱面库索引 | `%APPDATA%\com.dsh.guitar\library.json` | |
| AI 模型权重（demucs/MuScriptor） | `%LOCALAPPDATA%\com.dsh.guitar\models\` | 大文件走 LOCALAPPDATA，可随时删 |
| 缓存（音频解码缓存等） | `%LOCALAPPDATA%\com.dsh.guitar\cache\` | 可清 |
| 日志 | `%APPDATA%\com.dsh.guitar\logs\`（tauri-plugin-log，按日轮转，保留 7 天） | |
| BYOK 密钥 | Windows 凭据管理器 | **不落盘明文**，见 §7 |

（目标态口径）WebView2 内的 localStorage 依然存在（`EBWebView` 目录），但定位降级为**非关键 UI 状态**（面板折叠等）；任何用户不可再生的数据一律文件化。

### 5.2 浏览器版数据迁移（零改动下的现实答案）

- **不可行项先说死**：桌面应用读不到浏览器里 localStorage 的旧数据（IndexedDB 未使用；不同存储域，无 API），**自动迁移不存在**。
- **零改动路径（本方案采纳）**：桌面版首启为全新状态；用户手动重设主题/默认调弦等一次性偏好（成本极低；历史转谱结果本就未持久化，无实际损失）。
- 「设置导出/导入 JSON」按钮需要改 web 版与桌面版前端 → **前端机会清单（§3.3）**，二期经批准后实施。
- 欢迎页、模型下载引导等首启动 UI 属前端范畴，零改动不做；壳侧原生对话框只在异常场景出现（§5.4），正常首启零打扰。

### 5.3 卸载语义

- NSIS `currentUser` 卸载只删程序目录，**保留** `%APPDATA%`/`%LOCALAPPDATA%` 用户数据——卸载确认页明文告知"你的谱面与设置将保留，可手动删除目录"；FAQ 给出目录路径。
- 「打开数据目录」入口走**系统 UI 而非前端**：README 给出目录路径；诊断包原生对话框（§5.4）附带"打开数据目录"按钮——零改动下用户自助备份同样可达。

### 5.4 崩溃与诊断包（纯壳侧，零改动）

- **崩溃兜底**：Rust 侧 panic hook 写日志；退出时落"正常退出"标记，下次启动发现标记缺失 → 壳侧**原生对话框**提示"上次异常退出，可选择导出诊断包"（用系统对话框，不需要任何前端 UI 参与）。
- **诊断包导出**：一键 zip（壳侧日志 + 版本号 + 系统信息），**不含密钥与音频**，作为 issue 附件。入口：异常退出后的原生对话框，或快捷方式追加 `--diagnostics` 启动参数（README 说明）——全部系统 UI，不经前端。排障从"让用户描述现象"升级为"要一个文件"。
- 前端 error boundary、editOverlay 自动保存（30s debounce + 失焦 flush）等 → 前端机会清单（§3.3）二期；editOverlay 本身尚未在前端存在（v4.1 §2.4 规划项），天然属于二期。

---

## 6. Sidecar：demucs.cpp / MuScriptor（Step 4 硬前置）

> 零改动边界：sidecar 是**壳侧储备**——分轨在前端本无调用方（Step 4 规划），在壳里备好不破坏任何现状；TierRouter、下载 UI 等前端侧改动属 Step 4 已规划范畴，届时另行批准，不属本迁移。

### 6.1 外置二进制机制（已核实）

- `tauri.conf.json > bundle.externalBin: ["binaries/demucs"]`，磁盘文件必须带 **target triple + .exe** 后缀：`src-tauri/binaries/demucs-x86_64-pc-windows-msvc.exe`（triple 以 `rustc -Vv` 的 host 为准；漏后缀/拼错 triple 是 sidecar "No such file or directory" 的头号原因）。
- 运行时 `Command::new_sidecar("demucs")`（**不带** triple，Tauri 自动补），走 `shell:allow-execute` scoped 到该二进制。
- demucs.cpp 是自包含 C++ 二进制（GGML，v4.1 §1.1 已核实支持 htdemucs 全系），**首选 sidecar，无 Python 依赖**——Windows 上比 Python 方案省 100MB+ 与整个环境地狱。

### 6.2 模型权重分发

- 权重（htdemucs_ft 等，数百 MB）**不进安装包**：首用时由「下载管理器」（v4.1 §1.4 工作分解第 2 项）下载至 `%LOCALAPPDATA%\models\`，带断点续传 + 内容 hash 校验；下载源 = 本仓库 GitHub Releases 固定 tag 的 asset。
- **国内可达性（现实问题，必须设计进 v1）**：GitHub Releases 在中国大陆直连常失败或极慢，等于高配档对大陆用户不可用。三重保障：① Rust 下载器遵循**系统代理**（reqwest 0.12 的 `system-proxy` 特性默认开启，自动读环境变量与 Windows 注册表代理——用户挂 Clash 等即生效）；② **镜像 URL 备选列表**写入配置（ghproxy 类中转 / 自建 CDN，下载器按顺序降级尝试），内容 hash 校验保证镜像不可投毒；③ 重试 + 人类可读的错误提示（不裸抛网络栈错误）。上线前用大陆网络实测一轮。
- MuScriptor（Python sidecar，二期 opt-in）：Windows 用 python embeddable 发行版打包成自解压目录，体积代价大（torch CPU 轮子数百 MB）→ 沿 v4.1 §5 结论：**用户主动勾选才下载**，且其 CC BY-NC 权重须单独 opt-in。此条不改变"demucs.cpp 首选"的排序。

### 6.3 进程管理规范

- **杀进程树**：Windows 上杀 sidecar 必须 `taskkill /T` 语义（或 Job Object），否则孙进程残留占着模型内存。
- **防休眠（可选）**：分轨期间 `SetThreadExecutionState` 阻止系统睡眠/熄屏（笔记本跑高配档的典型场景），任务结束恢复；与 §3.4 P8 任务栏进度配套。
- stdout/stderr 流式回传（IPC event）→ 前端进度条与 §1.4 `runSeparation` 的 `onProgress` 对接；超时（`timeoutMs`）与取消（`signal`）语义在壳层实现。
- **路径规范**：所有 spawn 参数一律绝对路径 + 引号包裹；必须通过"中文用户名、路径带空格、中文文件名"三项测试（§10）——这是 Windows 子进程最高频翻车点。
- `runSeparation` 契约（v4.1 §1.4）不变，本文只是其 Windows 实现说明。

### 6.4 杀毒软件误报（现实风险，提前定策略）

- 未签名 Rust 主程序 + spawn 子进程 + 下载大模型，是 AV 误报高发组合。
- 缓解顺序：① Authenticode 签名（§8.4，最有效）；② 误报出现时向对应厂商（Microsoft/360/火绒）提交白名单申请，README 给指引；③ 模型下载走 GitHub Releases 固定域名，避免"从奇怪 URL 拉大文件"特征。
- 该风险计入"何时开始签名"的决策输入（§8.4）。

---

## 7. BYOK 与密钥

### 7.1 主进程代理（N7）

- **零改动现状**：前端已有直连 fetch 的 LLM 客户端（`llmClient.ts`，浏览器里怎么跑 WebView2 里就怎么跑，原样可用）；下述代理是二期切换目标，壳侧先把 command 备好。
- LLM 请求走 Rust command 封装的 HTTP 客户端（reqwest），前端 `platform/net.ts` 统一调用。
- 收益：密钥不进前端 JS 堆（降低被渲染层脚本意外序列化/日志化的面）、统一请求日志**脱敏**（Authorization 头永不落日志）、SSE 流式回传走 IPC channel。
- CORS 在壳内本就不是问题（自定义协议无同源限制），但这不是走代理的主因，密钥隔离才是。

### 7.2 密钥存储（N8）

- 首选 **Windows 凭据管理器**（keyring crate 直连，或 tauri-plugin-stronghold）；DPAPI 加密文件兜底（无凭据管理器的边缘环境）。
- 对应 v4.1 §1.4 spike 第 3 项验收（keychain）：写入→重启→读回→删除，四步过。
- **零改动边界**：现状 BYOK Key **仅会话内存、绝不落盘**（代码已核实）——桌面版零改动下每次启动需重填；迁凭据管理器需前端改「保存」落点 → 前端机会清单（§3.3）二期。壳侧凭据 command 先备好，届时即插即用（前端注释已规划此方向，见 §3.3）。

---

## 8. 安装器、签名、更新与分发

### 8.1 安装器格式决策

| 格式 | 结论 | 理由 |
| :--- | :--- | :--- |
| **NSIS（.exe）** | ✅ 主线 | Tauri 官方默认；updater 支持最好；`currentUser` 模式免 UAC（装 `%LOCALAPPDATA%\Programs`，自动更新不需要提权） |
| MSI（WiX） | ❌ 不做 | 面向企业批量部署，本产品无此客群；且 updater + MSI 有已知坑（安装参数传递、NSIS/MSI 混装把更新装到另一目录） |
| MSIX | ❌ 不做 | 微软商店沙箱形态；updater 不支持 MSIX；商店审核节奏不适配 |
| **portable zip** | ⚠️ 次要 | 直接 zip 发布版程序目录（WebView2 存在即可跑）；无文件关联/无自动更新；Release 页标注"绿色版" |

**只发一种 NSIS 安装器**是硬规则：同时发 .exe/.msi 会让 updater 通道出现混装（用户用 NSIS 装却下到 MSI 更新包，目录冲突）——这是 tauri-action 上的真实案例，不是理论风险。

### 8.2 安装器细节

- `installMode: currentUser`（默认），安装器内提供 perMachine 选项不做（双模式 = 双倍测试矩阵）。
- 语言：NSIS `SimpChinese` + `English`，默认随系统。
- 卸载行为见 §5.3。

### 8.3 自动更新

- `tauri-plugin-updater`：**minisign 签名强制、不可关闭**（这是更新包完整性校验，与代码签名无关，免费）。
  1. `tauri signer generate` 生成密钥对；**私钥离线保存**（丢失 = 换密钥 = 强制全体手动重装一次）；公钥进 `tauri.conf.json`。
  2. 构建配置：`bundle.createUpdaterArtifacts: true`（开启后每次构建产出带签名的更新包）；Release 流程：`tauri-action` 自动生成 NSIS 安装器签名与 `latest.json`（含版本/下载 URL/签名）→ 挂 GitHub Releases。
  3. 应用内「检查更新」→ 展示 changelog 摘要 → 用户确认 → 下载校验 → 静默安装 → 重启。默认**不自动后台更新**（尊重用户对生产工具的控制感），提供"启动时检查"开关。
- **首发即定稿——"烧进二进制"的三件套**：updater `endpoints` URL、updater `pubkey`、`identifier`（决定 `%APPDATA%` 路径）。三者随首发二进制固化，事后更换的代价分别是：存量安装更新通道断裂 / 存量不再信任更新签名 / 用户数据目录迁移。**首发前逐项终审，首发后视为不可改**；CI 对 endpoint 加占位符 fail-fast 拦截（§11.2 R1）。
- 更新包 URL 固定走 latest release 的 `latest.json`；**更新下载同样遵循系统代理**（updater 插件官方支持自动系统代理），大陆用户与模型下载（§6.2）同等待遇。
- **大陆可达性可再进一步**：updater `endpoints` 本身是数组、支持多源按序降级——镜像 URL 可配为第二端点（minisign 签名保证镜像不可投毒），与 §6.2 模型下载同策略；是否首发即启用，视 R6 演练的大陆实测而定。

### 8.4 代码签名（Authenticode，2026-10 现状核实）

| 方案 | 成本 | 效果 | 结论 |
| :--- | :--- | :--- | :--- |
| 不签名 | 0 | SmartScreen 弹"已保护你的电脑"（更多信息→仍要运行）；AV 误报率偏高 | **v1.0 采用**：开源免费软件 + README 首段图文引导过 SmartScreen；GitHub Releases 下载本身逐步积累信誉 |
| **Azure Artifact Signing**（2026 年由 Trusted Signing 更名） | Basic $9.99/月（5000 签名/月，超出 $0.005/个）；个人身份验证走 Azure 账单账户，**个人开发者可入驻** | OV 级证书；**SmartScreen 信誉仍需随下载量积累，不是签了就没弹窗** | **用户量起来后的首选**（约 ¥700~900/年，量级可接受） |
| Certum 开源证书 | ~€69/年（云签名版渠道价更高）；2026-02-27 起 CA/B 新规：单张证书最长 ~460 天，年年重签 | 同为 OV | 备选（无 Azure 账号时） |
| EV 证书 | $300+/年，硬件 token | 几乎即时 SmartScreen 信誉 | 不值：本产品非高分发量商业软件 |

**签名时机决策**：以两个信号触发——① Release 下载量稳定（如周下载 > 数百）；② 出现第一例 AV 误报报告且白名单申请无效。在此之前不签，省成本。

### 8.5 CI/CD 与架构

- GitHub Actions：`windows-latest` + `tauri-apps/tauri-action`（已建，含 W15 自动验证与 portable 打包，见 §11.1）；**action 与 CLI 均钉具体版本**——当前 `tauri-action@v0` 是浮动 major，上游升级可能悄悄改变构建行为；推 tag（`v*`）→ 构建 → （暂无 Authenticode）→ 自动生成 updater 签名与 `latest.json` → Draft Release 附产物；cargo/npm 缓存加速。Workflow 存 `.github/workflows/release-windows.yml`。
- 版本号：semver，与前端 `package.json`、`tauri.conf.json` 三处同源（脚本同步），tag 即版本。内测演练走 0.1.x 号段（R6）；**对外首发定 1.0.0 或带明确 beta 标注**——`0.1.0` 直接对外会让用户误判成熟度。
- **x64 主线**；Windows ARM64 可行（`aarch64-pc-windows-msvc` 交叉编译，或 `windows-11-arm` runner）但列二期可选——需求未出现前不加构建矩阵。

### 8.6 系统要求声明（README 与 Release 页明示）

| 档位 | 最低 | 推荐 |
| :--- | :--- | :--- |
| 轻量档闭环（basic-pitch） | Windows 10 2004+（WebView2 自动分发线）、x64、4GB RAM、~500MB 磁盘 | Windows 11、8GB RAM |
| 标准档 / 高配档（分轨） | 8GB RAM、额外 0.5~2GB 磁盘（模型权重） | 16GB RAM、独显或较强 iGPU |

安装器**不做硬性配置检测**（误杀率高，挡不住的机器也到不了安装完成）；首启动读取系统信息，低于最低配置时黄条提示但不阻止使用。

---

## 9. 安全清单（Tauri 2 权限模型）

- capabilities 按**最小权限**逐插件开（fs 限定应用目录 scope；shell execute 仅 scoped 到 sidecar；dialog 仅 open/save）——不用笼统的 `allow-all`。
- CSP：`default-src 'self'`，`media-src`/`font-src` 按需放行本地资源；**无任何远端页面加载**（BYOK 请求是数据 API，不是页面）。
- 更新通道 minisign 强制校验（§8.3）。
- Release 构建关闭 devtools。
- 日志脱敏中间件前置（§7.1），密钥/Authorization 永不入日志。
- `shell:allow-open` 仅限 `http(s)` 与本地目录（"打开下载页/数据目录"两个入口）。

---

## 10. Windows 专项测试矩阵（发布门禁）

**环境轴**：Win10 21H2（含一台无 WebView2 的 VM → 验证 bootstrapper 链路）/ Win11 23H2+ / 150% DPI / 深浅色切换 / **中文用户名** / 安装路径带空格。

| # | 用例 | 通过标准 |
| :--- | :--- | :--- |
| W1 | 全新安装（无 WebView2 机器） | 引导器自动装运行时，装完可启动 |
| W2 | 双击 `.agtp` 打开 | 起应用并聚焦已开实例；工程自动载入列二期（§4.3 零改动边界） |
| W3 | 拖拽含中文名/空格路径音频 | 正常解码，不闪退 |
| W4 | sidecar 全流程 | 分轨跑通、进度流回传、中途取消**无残留进程**（任务管理器验证） |
| W5 | 断网首启动 | 可进 UI、可跑轻量档闭环；模型下载入口给出明确离线提示 |
| W6 | basic-pitch WASM 推理 | WebView2 内正常（含无独显机器：WebGL 不可用时降级性能可接受） |
| W7 | 打印导出 PDF | 打印对话框出现、乐谱字体正确嵌入 |
| W8 | 自动更新 | 旧版→新版全流程；`latest.json` 签名校验失败时**拒绝安装**并提示 |
| W9 | 卸载 | 程序移除、`.agtp` 数据保留、注册表关联清理干净 |
| W10 | 凭据 | 写入→重启→读回→删除四步；凭据管理器中可见条目 |
| W11 | 音频格式矩阵 | WAV/MP3/FLAC/OGG/m4a(AAC) 全部可解码可播放（§4.5 已核实编解码器可用性） |
| W12 | 音频设备热切换 | 播放中拔插耳机：声音迁移到新设备继续，不静音不卡死 |
| W13 | 后台节流 | 最小化窗口跑轻量档推理/波形播放，`additionalBrowserArgs` 生效不被节流 |
| W14 | 崩溃与诊断 | 构造异常退出 → 下次启动壳侧原生对话框提示；诊断包 zip 内容完整且**不含密钥** |
| W15 | **零改动验证（迁移第一验收）** | ① 迁移分支 `git diff <迁移前基线> -- app/` 输出为空；② 同一 commit 下直接 `npm run build` 与 `cargo tauri build` 的前端产物 hash 一致——装进安装器的就是测过的那份前端 |

**性能门禁**：安装包 ≤ 25MB（不含模型权重）；冷启动（点击图标→可交互）≤ 3s（SSD 中位机）；空闲内存 ≤ 350MB（WebView2 常态开销内）；**转谱进行时波形拖动/播放 ≥50fps**——此为**迁移质量指标**：同一前端在 WebView2 内不得显著差于 Chrome 直开，差了先查壳侧（P1/P2/GPU），确属前端瓶颈则记录移交（P3~P6），仍然不改前端。测量口径（随 R3 发布清单一并归档）：冷启动 = 图标双击到首帧可交互（录像数帧）；内存 = 任务管理器"详细信息"页**私有工作集**；均在指定参考机测三次取中位。

---

## 11. 工作分解与里程碑

> M0 = v4.1 §1.4 已规划的外壳 spike，本文与它合流（M0 不通过则整个方案切 Electron 重跑 §2）。

| 里程碑 | 内容 | 验收 |
| :--- | :--- | :--- |
| **M0 spike**（先行，1~2 天） | 最小 Tauri 壳跑起现有前端；六项验收：体积/spawn/keychain/主进程 fetch/前端零改动/开发体验 | v4.1 §1.4 决策规则出结论 |
| **M1 零改动最小可安装版** | `src-tauri/`（仓库根）定型；单实例；窗口几何记忆；壳侧日志；§3.4 壳侧手段（P1 硬件加速验证 / P2 防节流参数 / P8 任务栏进度） | **W15 零改动三重验收** + W1/W3/W13 + 窗口状态重启保留；`cargo tauri build` 出 NSIS |
| **M2 集成完整（仍零改动）** | 文件关联（启动+聚焦，自动载入列二期）；打印验收；音频验收观察（§4.5，问题记录移交前端项目）；崩溃标记 + 原生对话框 + 诊断包（§5.4）；系统要求声明（§8.6）；portable zip | W2/W7/W9/W11/W12/W14 |
| **M3 Step 4 联动（壳侧储备）** | sidecar + 模型下载管理器 + BYOK 代理与凭据 command（= v4.1 §1.4 工作分解 3~5 的 Windows 侧实现）。**注**：TierRouter/下载 UI 等前端改动属 Step 4 已规划范畴，届时另行批准——不属本迁移 | W4/W5/W10（壳侧集成测试驱动，无需 UI）+ `runSeparation` 契约全绿 |
| **M4 发布就绪** | CI 流水线、minisign 密钥与流程、README 安装指引（含 SmartScreen 引导）、全量测试矩阵 | §10 全过（含 W15 复验）+ 模拟更新演练 |

依赖关系：**M0~M2 全程零改动**；M3 的壳侧部分同样零改动（前端接入另行立项）。M3 依赖 M1 的壳工程，但**不阻塞 M2**——M2 完成即可发"现有功能完整入壳"的早期版本（无分轨无 BYOK，先拿到真实用户与环境反馈，正是 §8.4 签名时机决策需要的信号）。

### 11.1 实施状态快照（2026-10-26，工程细节以 `src-tauri/README.md` 为准）

壳已实际落地，进度超出上表原排期：**M0/M1/M2 完成**（单实例+参数转发、窗口几何记忆、壳日志轮转、防节流参数、任务栏进度、`.agtp` 文件关联+pending-open 暂存、崩溃标记+原生对话框+诊断包）；**M3 全部为已就绪储备**（sidecar spawn/杀进程树/进度流/防休眠、BYOK 代理 `llm_fetch`、凭据 `secrets_*`、模型下载器 `download_model`，前端接入点清单见 src-tauri/README「二期前端接入点」）；**M4 部分完成**（minisign 签名链路、启动更新检查默认关、CI 流水线 `.github/workflows/release-windows.yml` 已含版本三处同源校验 + **W15①②全自动** + portable zip 打包；正式密钥、真实 endpoint、真机矩阵、体积实测未完）。

W15 执行口径更新：**以 CI 为权威**——每次推 tag 自动做 app/ 源码哈希前后比对 + dist 产物哈希前后比对（tauri build 内部执行与直建完全同一条 npm 命令）；`src-tauri/qa/*.sha256` 保留为本机等价物（仓库暂无 git；init git 后 W15① 可加 `git diff` 双口径）。**基线再生成纪律**：`qa/*.sha256` 只能由前端项目发版节点人工重生成——严禁"改了 app/ 再顺手重生成基线"，那会让本机验证空转；git 化后基线废弃、切 `git diff` 口径。观察项：W15② 依赖 Vite 构建确定性，若 CI 偶发不一致，排查非确定性来源（chunk 哈希、生成时间戳等），**不得借机放宽为零改动承诺**。

### 11.2 发布前待办（Blockers；实施侧已识别占位项，本节为风险分析后的定稿清单）

| # | 待办 | 风险分析 | 完成标准 |
| :--- | :--- | :--- | :--- |
| R0 | **远端仓库建立与首次推送**：本地尚无 git（2026-10-26 实测），而 R1 换 endpoint、CI 运行、Releases 挂 `latest.json`、更新演练全部以 GitHub 仓库存在为前提——这是所有发布待办的隐藏第 0 步（P0） | 没有 R0，后面每条都在"假设仓库已存在"上空转；owner/repo（R1 的答案）也在此一并定死 | git init → 全局 `.gitignore` 核查（`node_modules` / `dist` / `src-tauri/target` / `keys/*.key` 全覆盖——目前仅 src-tauri 内层有）→ 首次推送 → owner/repo 定稿（喂给 R1 与 `identifier` 终审） |
| R1 | **updater endpoint 占位替换**：当前 `github.com/dsh/ai-guitar-transcriber` 为占位符（P0） | endpoint 烧进首发二进制（§8.3 三件套），发布后再换 = 存量安装更新通道永久断裂，不可依赖 GitHub 仓库改名重定向救场；且 **CI 目前无占位符拦截**——今天推 tag 会产出一个更新器指向不存在仓库的"正式"安装器 | 真实 owner/repo 替换；CI 增加占位符 fail-fast 步骤（检出占位模式即 fail）；首发后 `latest.json` 返回 200 实测。**顺带终审 `identifier: com.dsh.guitar`**——同一占位来源，影响 `%APPDATA%` 路径，首发后改名 = 用户数据目录迁移事故 |
| R2 | **minisign 正式密钥替换**（当前为无密码开发钥，P0） | `pubkey` 同样烧进首发二进制——首发后再换钥 = 存量更新签名全部不被信任。**当前尚无公开发布，是零成本替换窗口**；正式私钥丢失 = 全体断更且无法补发，必须离线双备份 | 带密码新密钥对生成 → `tauri.conf.json` pubkey 更新 → CI Secrets 同步 → 私钥移出仓库目录离线保存（`src-tauri/.gitignore` 的 `/keys/*.key` 已防入库，属第二道防线）。纪律：库内开发钥（`updater.key`）**永不签任何公开发布物** |
| R3 | **真机测试矩阵人工跑：W1~W14（W15 已由 CI 自动覆盖）**（P1） | 壳侧行为冒烟已覆盖；需真机人工的剩余项 = WebView 内验收（W6 WebGL/WASM、W7 打印、W11 编解码、W12 设备热切换、W13 防节流）+ 安装器路径（W1 无 WebView2 机器引导安装、W9 卸载保留数据）——CI 无法替代 | §10 矩阵转为按版本归档的发布清单（机型/结果/截图随版本存档）；最小机型集 = 无 WebView2 的 Win10 VM + Win11 物理机（150% DPI）+ 中文用户名账户 + 带空格安装路径 |
| R4 | **安装包体积实测 ≤25MB**（P1） | §10 性能门禁首项，当前无实测数 | CI 在 Draft Release 后追加体积断言（检查 NSIS 产物大小，超标即 fail），从此不再依赖人工记得 |
| R5 | **msvc.cmd 环境包装边界注记**（P2，非阻断） | Git Bash link.exe 遮蔽是 MSYS 环境经典坑；包装脚本（vswhere 定位 → vcvars64 → rustup PATH 前置）已解，零侵入未破（脚本在 `src-tauri/scripts/`，不碰 app/）。CI 走 pwsh/bash 不受遮蔽影响——**不要在 CI 里"顺手"套用** | 已完成，保持现状即可；仅一条补充建议：本地 npx 的 `@tauri-apps/cli` 固定次版本与 CI 对齐（见 §3.1） |

| R6 | **更新链端到端演练**（P1，M4"模拟更新演练"的具体化） | 更新器从未对着真实 GitHub Release 跑过全链路——检查更新→下载→minisign 校验→安装→重启，任何一环的 bug 只能靠真实双版本暴露 | R1/R2 完成后连发两个内测 tag（如 v0.1.0→v0.1.1），实机验证全链路 + `latest.json` 返回 200；通过后才允许对外首发 |
| R7 | **Rust 侧第三方许可清单**（P1，合规） | `app/THIRD-PARTY-NOTICES.txt` 只覆盖 npm 依赖；壳工程引入整棵 Rust crate 树（tauri 系，MIT/Apache-2.0 层叠）——开源发布须随安装器分发声明 | 用 cargo about 类工具在 src-tauri 侧生成（不碰 app/，零改动未破），并入现有 NOTICES 或平行文件，Release 页与安装器携带 |
| R8 | **根 README 反映桌面版**（P1） | 根 README 的工作区结构没有 `src-tauri/`、进度表没有桌面壳条目、文档链接没有本文档——新访客看不出项目有 Windows 原生应用。README 在仓库根，改它不违反零改动 | 结构图补 `src-tauri/`、进度表补桌面壳行（指向 §11.1 状态）、文档列表加本文档链接；顺带补 SmartScreen 引导文案位（§8.4） |
| R9 | **文档间状态同步：v4.1 的"外壳待决"已过时**（P2，处理方式待用户拍板） | v4.1 §0/§1.4/§6 仍写"打包外壳待决（Tauri/Electron），spike 拍板"——与现状（已定 Tauri 2.12 且落地）相反，两份文档并存会误导后来者 | 二选一：v4.1 加一行"已定 Tauri 2.12，见 Windows 原生应用方案"；或声明 v4.1 冻结为历史快照不再回改 |

> R0~R2 是仅有的三个 P0：R0 是一切的前置（仓库不存在则其余全空转），R1/R2 的共同本质是"**首发即烧死**"（§8.3 三件套）——错过首发前窗口，纠正成本从"改一行配置"变成"全体用户手动重装"。R3/R4/R6 是发布质量门槛，R5 是环境备忘，R7~R9 是合规与文档一致性。

---

## 12. 风险与开放问题

| 风险 | 影响 | 应对 |
| :--- | :--- | :--- |
| WebView2 Evergreen 自动升级引入前端回归 | 理论上任何 Chromium 更新都可能 | 不钉版本；§10 矩阵在 Win10/Win11 双环境覆盖；alphaTab/Web Audio 均为成熟 API，风险低 |
| Rust 侧维护（团队 Node 背景） | 迭代摩擦 | 主进程代码收敛到 4 类 command（§3.3），复杂逻辑全留前端；Rust 侧目标 <500 行 |
| AV 误报（§6.4） | 用户流失第一现场 | README 引导 + 白名单申请 + 达标即签名 |
| SmartScreen 劝退 | 新用户转化率 | 图文引导 + Release 说明置顶；若实测转化差，提前启用 Artifact Signing |
| `identifier` 定稿后不可改 | 改 = 数据目录迁移事故 | M1 前定死 `com.dsh.guitar`（或团队命名规范），写进 PR 模板检查项 |
| alphaTab/sonivox 在 WebView2 的音频细节（设备切换、独占模式） | 播放异常 | M1 验收覆盖常规播放；异常设备场景收集反馈再说 |
| 国内网络：模型/更新下载可达性 | 大陆用户下载失败 = 高配档不可用 | §6.2 三重保障（系统代理/镜像/hash）；上线前大陆网络实测 |
| 零改动约束 vs 能力终态：N3/N4/N8/N10 首版降级兑现（§3.3 矩阵） | 桌面版功能弱于设计终态 | 用户已拍板零改动优先；降级项均为"可用"而非"缺失"（如 localStorage 在 WebView2 内持久）；解锁项全部列在 §3.3 前端机会清单，二期逐项批准、一项一动 |
| 首发后更换 updater endpoint / pubkey / identifier（§8.3"烧死三件套"） | 存量断更或数据目录迁移，纠正成本 = 全体手动重装 | §11.2 R1/R2 首发前终审；CI 加占位符 fail-fast；私钥离线双备份 |
| 开放：macOS/Linux | — | Tauri 下加构建目标即可，产品决策另行立项 |
| 开放：Windows ARM64 | Surface/骁龙本用户 | §8.5，需求出现再加矩阵 |

---

## 附录 A：事实核查记录（2026-10-25 联网核实）

| 事实 | 来源 |
| :--- | :--- |
| Tauri 2.12 为 2.x 最新大版本（2026-09-26 发布） | [Tauri 官方博客](https://v2.tauri.app/blog/tauri-2-12/) · [v2.tauri.app](https://v2.tauri.app) |
| WebView2 Evergreen：Win11 全预装；Win10 2004+ 自 2023-01 起随 Windows Update 分发；bootstrapper/离线安装器官方提供 | [Microsoft Learn: Evergreen vs Fixed](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version) · [Edge 团队博客 2022-12](https://blogs.windows.com/msedgedev/2022/12/14/delivering-microsoft-edge-webview2-runtime-to-managed-windows-10-devices) |
| updater：minisign 签名强制不可关；支持 NSIS/MSI，MSIX 非更新目标；MSI 更新存在已知问题 | [Tauri Updater 文档](https://v2.tauri.app/plugin/updater) · [plugins-workspace #1449](https://github.com/tauri-apps/plugins-workspace/issues/1449) · [tauri-action #1027（NSIS/MSI 混装）](https://github.com/tauri-apps/tauri-action/issues/1027) |
| sidecar externalBin 命名：`name-$TARGET`，Windows 为 `x86_64-pc-windows-msvc.exe`；spawn 不带 triple | [tauri #1236](https://github.com/tauri-apps/tauri/issues/1236) · [tauri #13767](https://github.com/tauri-apps/tauri/issues/13767) |
| Azure Trusted Signing 已更名 **Artifact Signing**：Basic $9.99/月含 5000 签名、个人身份验证走 Azure 账单账户、证书为 OV 级 | [Azure 定价页](https://azure.microsoft.com/en-us/pricing/details/artifact-signing) · [快速入门](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) |
| Certum 开源签名证书 ~€69/年起；2026-02-27 起 CA/B 规则单张证书最长 ~460 天 | [Certum 商店](https://shop.certum.eu/code-signing.html) |
| Windows ARM64：`aarch64-pc-windows-msvc` 交叉编译可行，官方 runner 支持仍在完善 | [tauri-action #952](https://github.com/tauri-apps/tauri-action/issues/952) · [tauri 讨论 #4528](https://github.com/orgs/tauri-apps/discussions/4528) |
| demucs.cpp（GGML）支持 htdemucs 系列权重 | v4.1 §1.1 已核实（本文引用） |
| WebView2 音频编解码：开源格式（MP3/FLAC/Opus/Vorbis）原生；AAC/m4a 走 Edge 授权编解码器，WebView2 内可用 | [Chromium codec 文档](https://www.chromium.org/audio-video) · [MDN 音频编解码指南](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs) |
| reqwest 0.12 `system-proxy` 特性默认开启（自动读环境变量与 Windows 注册表代理）；updater 插件支持自动系统代理 | [reqwest 0.12 features](https://docs.rs/crate/reqwest/0.12.23/features) · [tauri-plugin-updater](https://docs.rs/tauri-plugin-updater) |
| 代码现状核查（2026-10-25 本仓库实测）：界面偏好存 localStorage（`settings.tsx` 单一 STORAGE_KEY）；BYOK Key 仅会话内存、绝不落盘（`copilot.tsx` / `SettingsModal.tsx` 注释）；IndexedDB 未使用；LLM 直连客户端 `llmClient.ts` + 测试已存在；`vite.config.ts` 显式 `server.port 5173`（无 strictPort）；`package.json` 仅 dev/build/preview/test 四脚本、无 tauri 依赖 | 本仓库 `app/` 源码 |
| 实施快照（2026-10-26 本仓库实测）：`src-tauri/` 已落地（M1/M2 完成、M3 储备 command 就绪、CI 含 W15 自动验证/portable 打包）；updater endpoint owner=`dsh` 为占位符；开发 minisign 钥在 `keys/`（`src-tauri/.gitignore` 已防私钥入库）；仓库暂无 git，W15 本机口径走 `qa/*.sha256` 哈希基线 | 本仓库 `src-tauri/`、`.github/workflows/release-windows.yml` |
