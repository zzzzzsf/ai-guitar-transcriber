# binaries/ — Sidecar 外置二进制（方案 §6，M3 落地项）

本目录存放随包分发的外置二进制（demucs.cpp 等）。**当前为空是预期状态**：
分轨在前端本无调用方（Step 4 规划），壳侧 `sidecar_run` command 已备好（见
`src/commands.rs`），二进制到位后即插即用。

## 落地步骤（M3）

1. 编译 demucs.cpp（GGML 后端，自包含 C++ 二进制，无 Python 依赖——v4.1 §1.1），
   产出 Windows x64 Release 版可执行文件。
2. 按下表命名放入本目录（**target triple 必须与 `rustc -Vv` 的 `host:` 一致**，
   本机为 `x86_64-pc-windows-msvc`；漏后缀/拼错 triple 是 sidecar
   "No such file or directory" 的头号原因——方案 §6.1）：

   | 磁盘文件名 | 配置名（运行时引用，不带 triple） |
   | :--- | :--- |
   | `demucs-x86_64-pc-windows-msvc.exe` | `demucs` |

3. 在 `tauri.conf.json > bundle` 中加回（缺文件会让 `tauri build` 直接失败，
   这也是当前未启用它的原因）：

   ```json
   "externalBin": ["binaries/demucs"]
   ```

4. 验收：方案 §10 W4（分轨跑通、进度流回传、中途取消任务管理器无残留进程）。

## 命名速查

```bash
rustc -Vv | grep host    # → host: x86_64-pc-windows-msvc
```

进程管理规范（杀进程树 taskkill /T、防休眠、进度流事件 `sidecar:event`、
绝对路径 + 引号包裹传参）已在壳侧实现，见 `src/commands.rs` 的
`sidecar_run` / `sidecar_cancel`。
