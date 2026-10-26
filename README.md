# AI 智能扒谱（ai-guitar-transcriber）

高颜值、免费开源、本地离线优先的智能音乐扒谱软件。首期 Guitar-First：专精木吉他（指弹/弹唱）与电吉他（Solo/Riff），自动生成符合手指生理结构的**六线谱（Tab）+ 五线谱**。

- 产品愿景 / 技术栈 / 三档性能 / 算法框架：见 [docs/吉他扒谱.md](docs/吉他扒谱.md)（v4.0）
- 工程决策细节（pipeline 契约、Viterbi 代价、Auto-Capo、BPM）：见 [docs/吉他扒谱-细化方案 v4.1.md](docs/吉他扒谱-细化方案%20v4.1.md)
- Windows 原生桌面壳（Tauri 2.12 + NSIS）：见 [docs/吉他扒谱-Windows原生应用方案 v1.0.md](docs/吉他扒谱-Windows原生应用方案%20v1.0.md)

## 工作区结构

```
Guitar/
├── docs/                          # 方案文档（v4.0 + v4.1 + Windows 原生应用方案 v1.0）
├── app/                           # 主程序（Vite + React 18 + TypeScript）——整体冻结零改动
│   ├── public/font, public/soundfont   # alphaTab 乐谱字体 & sonivox 音源（离线，构建时自动拷贝）
│   └── src/
│       ├── components/            # UI：HeaderBar / AudioDropzone / TabViewer / WaveformMixer / AiCopilotPanel / PlaybackBar
│       ├── core/                  # quantizer（BPM 检测/tap/量化）、audioPreprocessor（前处理）
│       ├── profiles/              # 乐器插件库：IInstrumentProfile 契约 + GuitarProfile（Viterbi 弦品寻路 + Auto-Capo）+ costWeights + registry
│       ├── demoSong.ts            # 演示乐句（含扫弦错位/推弦弯音/闷音）
│       └── types.ts
├── src-tauri/                     # Windows 原生外壳（Tauri 2.12，工程细节见其 README）
└── .github/workflows/             # CI：release-windows.yml（推 tag → NSIS + portable + 签名更新包）
```

## 运行

```bash
cd app
npm install        # 首次
npm run dev        # 开发：http://localhost:5173
npm test           # Vitest（198 个用例：GuitarProfile 全流水线 + BPM/量化 + Step 3 转谱 + Step 4 引擎）
npm run build      # 产物构建（tsc 类型检查 + vite build）
```

打开页面后进入 **设置 → 测试**，点「**运行演示（内置示例乐句）**」可直观看到五步流水线效果（音域/复音过滤 → 扫弦聚拢/推弦合并 → Auto-Capo 推导 → Viterbi 弦品寻路 → 技巧检测 → alphaTex 渲染）；同分区还可加载演示音频（80→60 变速点击轨）验证波形网格 overlay。

## Windows 原生版（桌面壳，详见 [src-tauri/README.md](src-tauri/README.md)）

按 [Windows 原生应用方案 v1.0](docs/吉他扒谱-Windows原生应用方案%20v1.0.md) 落地：Tauri 2.12 + Evergreen WebView2 + NSIS 安装器。**`app/` 前端整体冻结零改动**（方案 §3.3，CI 中 W15 双重机器验证），所有原生化工程只发生在 `src-tauri/` 与 `.github/`。

```bash
# 开发（Git Bash 下请经 msvc.cmd 包装进入 MSVC 环境；CLI 钉 2.12.4 与 CI 对齐）
cd src-tauri
scripts/msvc.cmd npx --yes @tauri-apps/cli@2.12.4 dev     # 自动拉起 app/ 的 Vite（5173）
scripts/msvc.cmd npx --yes @tauri-apps/cli@2.12.4 build   # 产出 NSIS 安装器（%LOCALAPPDATA%\Programs，免 UAC）

# 本地出带签名的更新包前需注入（正式密钥流程见 src-tauri/keys/README.md）
export TAURI_SIGNING_PRIVATE_KEY="$(pwd)/keys/updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

- **安装**：双击 NSIS 安装器即可（开始菜单/桌面图标，离线运行）。v1.0 未做 Authenticode 签名（开源免费软件），首次运行如遇 SmartScreen「已保护你的电脑」→ 点「更多信息」→「仍要运行」。
- **系统要求**：Windows 10 2004+ / Windows 11，x64，4GB RAM（轻量档闭环 ~500MB 磁盘）；分轨档建议 8GB+ RAM 与额外 0.5~2GB（模型权重）。缺 WebView2 运行时时安装器自动引导安装。
- **数据目录**：`%APPDATA%\com.dsh.guitar`（设置/日志/诊断包）、`%LOCALAPPDATA%\com.dsh.guitar`（模型/缓存）。卸载保留以上用户数据，可手动删除目录。
- **文件关联**：双击 `.agtp` 工程文件可启动并聚焦应用（自动载入工程属二期）。
- **诊断**：快捷方式追加 `--diagnostics` 启动参数，或异常退出后按提示一键导出诊断包（日志 + 版本 + 系统信息，不含密钥与音频）。
- **更新**：minisign 签名校验强制；应用内默认不自动后台更新。

## 当前进度（对应 v4.0 路线图）

| 阶段 | 内容 | 状态 |
| :--- | :--- | :--- |
| Step 1 | React + Tailwind 暗黑 UI + alphaTab 六线谱渲染/播放光标/变速；主题专栏（深色/浅色模式 + 主题色切换 + 音符颜色 + 小节号跟随主题色） | ✅ 完成 |
| Step 2 | `GuitarProfile.ts`：Viterbi 寻路（7 项代价 + beam search）、Auto-Capo（Top3 推荐）、扫弦聚拢、推弦合并、技巧检测；**§3.3 调性检测 `keyDetector.ts`（KS）+ `\ks` 调号输出**；**§3.1 三连音双网格量化**；**§3.5 变速曲处理（BOCPD 变点 + CI 判据 + 渐变趋势检测 + 候选确认流/一键插段 + 波形网格 overlay）** | ✅ 完成 |
| Step 3 | `@spotify/basic-pitch` 已接入（随包 0.9MB 模型，运行期零联网）：拖入音频 → 前处理 → BPM 检测 → 推理 → GuitarProfile 出谱全链路跑通；§3.2 长曲分段（静音切点 + 重叠兜底，后处理全局）；§2.1 泛音误检抑制（标记制）；§3.4 原曲对照开关。**待真实语料（GuitarSet/自录）做 §1.2 基线实测校准** | 🔶 部分接入，待真实语料校准 |
| Step 4 | 高配/标准档 demucs 分轨 sidecar + 大模型 BYOK 实际调用 + 工程持久化（`.agtp/`）。**BYOK 全链路 ✅（2026-10）**：连接面板/预设保存 + `llm/llmClient`（统一 chat 客户端：重试/超时/中止/Key 脱敏）+ 三特性编排器（`chordAnnotator` 标和弦·LLM 失败自动降级本地 / `aiRewrite` AI 改谱·本地降把位降级 / `stemSplitter` 双吉他拆轨·无降级）+ `texGuard` 前置校验（可解析 + `\tempo` 保留 + diff 统计）+ 主面板 AiCopilotPanel UI（指令/预设/diff 预览确认流/拆轨应用/撤销），浏览器 E2E 通过、Key 只存会话内存绝不落盘。**引擎就绪 ✅**：`io/fsAdapter`（OPFS/Node/内存统一文件系统 + 原子写）、`persistence/projectFile + editOverlay`（`.agtp` 目录工程、AI 快照回滚、§2.4 修正打标回放合并）、`main/separatorRunner + tierRouter + stemsCache + modelDownloader`（分轨子进程契约、失败自动回落轻量档、hash 缓存、双源下载）。分轨二进制对接与 keychain 随桌面外壳（Tauri spike）落地 | ✅ BYOK 完成 · 分轨随外壳 |
| 桌面壳 | Windows 原生化（Tauri 2.12 + NSIS，**`app/` 前端整体冻结零改动**，壳工程在 `src-tauri/`）：M0/M1/M2 完成、M3 壳侧储备就绪（sidecar/BYOK 代理/凭据/模型下载器）、M4 部分完成（CI 含 W15 全自动验证 + 三件套终审门禁 + 体积断言）——实施状态见 [Windows 原生应用方案 §11.1](docs/吉他扒谱-Windows原生应用方案%20v1.0.md)，发布前待办见其 §11.2 | 🔶 部分完成 |

## 开源协议

主程序 MIT（见 `app/LICENSE`）；第三方组件声明见 `app/THIRD-PARTY-NOTICES.txt`。
