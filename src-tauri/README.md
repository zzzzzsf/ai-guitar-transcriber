# src-tauri/ — Windows 原生外壳（Tauri 2.12）

> 方案文档：[docs/吉他扒谱-Windows原生应用方案 v1.0.md](../docs/吉他扒谱-Windows原生应用方案%20v1.0.md)
> （下文 §N 均指该文档章节）

**第一约束：`app/` 整体冻结零改动（§3.3）**——不修改、不新增、不删除任何文件。
壳适配前端，而不是前端适配壳。本工程是仓库根下独立的 Rust 工程，不给
`app/package.json` 加任何依赖或脚本；Tauri CLI 一律经 `npx @tauri-apps/cli`
调用。

## 目录

```
src-tauri/
├── src/main.rs        入口：插件注册 / 单实例 / 崩溃标记 / --diagnostics / 更新检查接线
├── src/commands.rs    全部 IPC command 收敛在此（四类储备 + 壳侧辅助）
├── src/logging.rs     壳侧日志：按日轮转（本地时区）保留 7 天
├── src/diagnostics.rs 诊断包导出
├── src/download.rs    模型权重下载内部实现（续传/镜像降级/hash）
├── src/updater.rs     启动时更新检查（默认关）
├── src/native.rs      原生消息框
├── binaries/          sidecar（M3 落地，见其 README）
├── icons/             icon.ico（多尺寸）+ png（scripts/make-icon.ps1 生成）
├── keys/              minisign 更新签名密钥（开发钥；正式钥生成后离线保存）
├── capabilities/      Tauri 2 权限：仅 core:default（§9 最小权限）
├── scripts/           make-icon / check-versions / release-gate / make-release-key / msvc.cmd
└── qa/                零改动验证用的哈希清单（W15 本机等价物；CI 为权威口径，§11.1）
```

## 开发与构建

```bash
# 工具链：Rust MSVC（rustup）+ VS Build Tools C++ 工作负载 + Node/npm + WebView2 运行时
# 注意（§3.1）：Git Bash 下 link.exe 会被 /usr/bin/link 遮蔽，本地命令走 MSVC 包装；
# CLI 钉次版本 2.12.4（§3.1/R5：与 CI 对齐防漂移；升级时本地与 CI 同步改）
scripts/msvc.cmd cargo check                              # 或任何 cargo 命令
scripts/msvc.cmd npx --yes @tauri-apps/cli@2.12.4 dev     # 开发（自动拉起 app/ 的 Vite，devUrl 5173）
scripts/msvc.cmd npx --yes @tauri-apps/cli@2.12.4 build   # 出 NSIS 安装器

# 版本三处同源校验（app/package.json / tauri.conf.json / Cargo.toml）
bash scripts/check-versions.sh
```

本地构建更新包签名（正式流程见 `keys/README.md`）：

```bash
export TAURI_SIGNING_PRIVATE_KEY="E:/dsh_flies/Guitar/src-tauri/keys/updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

## 壳侧已实现能力（对应方案里程碑）

| 里程碑 | 能力 | 代码位置 |
| :--- | :--- | :--- |
| M1 | 单实例 + 二次启动聚焦 + 参数转发（§4.2） | main.rs single-instance |
| M1 | 窗口几何记忆（§4.1） | tauri-plugin-window-state |
| M1 | 壳侧日志按日轮转 7 天（§3.4 P7） | logging.rs |
| M1 | P2 防后台节流（保留官方默认 flag 仅追加） | tauri.conf.json additionalBrowserArgs |
| M1 | P8 任务栏进度（sidecar 进度不经前端直达任务栏，stdout/stderr 均解析） | commands.rs set_taskbar |
| M2 | `.agtp` 文件关联 + 双击启动聚焦（自动载入列二期，§4.3） | tauri.conf.json fileAssociations + main.rs pending-open |
| M2 | 崩溃标记 + 原生对话框 + 诊断包 zip（§5.4） | main.rs + diagnostics.rs + native.rs |
| M3 储备 | sidecar spawn / 杀进程树 taskkill /T / 进度流事件 / 防休眠（§6.3） | commands.rs sidecar_run/cancel |
| M3 储备 | BYOK 代理（Authorization 不落日志、SSE 走 IPC channel，§7.1） | commands.rs llm_fetch |
| M3 储备 | 凭据管理器读写删（§7.2，W10 四步验收就绪） | commands.rs secrets_* |
| M3 储备 | 模型下载器（系统代理/镜像降级/hash 校验/断点续传/416 边界，§6.2） | commands.rs download_model + download.rs |
| M4 | minisign 更新签名 + 启动时检查（默认关，§8.3） | keys/ + updater.rs |

## 零改动验证（W15；§11.1：以 CI 为权威，本节为本机等价物）

```bash
# ① app/ 源文件零改动（git 化后改用 `git diff <迁移前基线> -- app/` 双口径）
cd .. && find app -type f ! -path "app/node_modules/*" ! -path "app/dist/*" -print0 \
  | sort -z | xargs -0 sha256sum > /tmp/app-now.sha256
diff src-tauri/qa/app-baseline.sha256 /tmp/app-now.sha256 && echo "app/ 零改动 ✓"

# ② 前端产物零分叉：tauri build 前后各做一次 dist 哈希比对（tauri build 内部
#    执行的是同一条 npm --prefix app run build）
find app/dist -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/dist-after.sha256
diff src-tauri/qa/dist-baseline.sha256 /tmp/dist-after.sha256 && echo "产物 hash 一致 ✓"
```

**基线再生成纪律（§11.1）**：`qa/*.sha256` 只能由前端项目发版节点**人工重生成**——
严禁"改了 app/ 再顺手重生成基线"，那会让本机验证空转；git 化后基线废弃、切
`git diff` 口径。观察项：W15② 依赖 Vite 构建确定性，偶发不一致时排查非确定性
来源（chunk 哈希、时间戳等），不得放宽零改动承诺。

**§10 性能门禁测量口径（随 R3 发布清单归档）**：冷启动 = 图标双击到首帧可交互
（录像数帧）；内存 = 任务管理器"详细信息"页**私有工作集**；均在指定参考机测
三次取中位。

## 二期前端接入点（§3.3 前端机会清单，届时另行批准）

- `pending_open_take()` — 双击 `.agtp` 的自动载入
- `secrets_*` — BYOK Key 迁 Windows 凭据管理器（「保存」落点）
- `llm_fetch` — LLM 直连 fetch 切主进程代理
- `sidecar_run/sidecar_cancel` + `sidecar:event` 事件 — 分轨（runSeparation 契约不变）
- `download_model` — 模型下载管理器后端
- `paths_get` — `.agtp` 文件化工程的路径基座

## 发布前待办（= 方案 §11.2 定稿清单 R0~R9）

| # | 待办 | 工具/状态 |
| :-- | :--- | :--- |
| R0 (P0) | 远端仓库建立与首次推送；owner/repo 定稿（喂给 R1 与 identifier 终审） | **部分完成**：根 `.gitignore` 已建（node_modules/dist/target/私钥全覆盖，已核），`git init` + 全量暂存核查通过（130 文件，公钥入库、私钥排除）。**剩余**：配置 git 身份 → 首笔 commit → GitHub 建仓推送 → owner/repo 定稿 |
| R1 (P0) | updater endpoint 占位替换为真实 owner/repo + identifier 终审 | **CI 已有 fail-fast 拦截**（`scripts/release-gate.sh`，推 tag 必过）；替换后实测 `latest.json` 200。§8.3 备注：updater endpoints 支持多源降级，大陆镜像可作第二端点（minisign 保证不可投毒），是否首发启用视 R6 实测 |
| R2 (P0) | minisign 正式钥（带密码、私钥移出仓库离线双备份） | **流程工具就绪**：`bash scripts/make-release-key.sh <仓库外目录>`；**CI 拦截开发钥**。纪律：库内开发钥永不签公开发布物 |
| R3 (P1) | 真机矩阵人工跑 W1~W14（W15 已 CI 自动覆盖） | 需真机：无 WebView2 的 Win10 VM + Win11 物理机（150% DPI）+ 中文用户名 + 带空格路径；测量口径见上文 §10 注 |
| R4 (P1) | 安装包体积 ≤25MB | ✅ **CI 已有断言**（Release 创建前置门禁 + Draft 后复验；本机实测 15.2MiB） |
| R5 (P2) | msvc.cmd 环境包装边界 | ✅ 已完成保持现状；CLI 钉 2.12.4、tauri-action 钉 v1.0.0（本地/CI 对齐） |
| R6 (P1) | 更新链端到端演练（M4"模拟更新演练"具体化） | R1/R2 完成后连发两个内测 tag（v0.1.0→v0.1.1，走 0.1.x 内测号段；对外首发定 1.0.0 或带 beta 标注——§8.5），实机验证 检查→下载→校验→安装→重启 全链路 + `latest.json` 200 |
| R7 (P1) | Rust 侧第三方许可清单（合规） | cargo-about 生成 `THIRD-PARTY-NOTICES-RUST.txt`（不碰 app/），随安装器分发、Release 页携带 |
| R8 (P1) | 根 README 反映桌面版 | ✅ 已补：文档链接 / 结构图 / 进度表桌面壳行 / SmartScreen 引导 |
| R9 (P2) | v4.1 文档"外壳待决"表述过时 | **处理方式待用户拍板**：v4.1 加一行"已定 Tauri 2.12"，或声明冻结为历史快照 |

其他：
- [ ] git 化后 W15① 切 `git diff` 双口径、`qa/*.sha256` 基线废弃（§11.1）
