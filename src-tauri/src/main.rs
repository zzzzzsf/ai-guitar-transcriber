// AI 智能扒谱 · Windows 原生外壳（Tauri 2）
// 方案：docs/吉他扒谱-Windows原生应用方案 v1.0.md
// 第一约束：壳适配前端——app/ 整体冻结零改动（§3.3），所有原生能力在本进程内实现。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod diagnostics;
mod download;
mod logging;
mod native;
mod updater;

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;

use tauri::Manager;

/// 与 tauri.conf.json > identifier 同源。决定 %APPDATA%/%LOCALAPPDATA% 目录名，
/// 上线前定死不再改（§12 风险表：改 = 数据目录迁移事故）。
pub const IDENTIFIER: &str = "com.dsh.guitar";

// ---------- 崩溃标记（§5.4）----------
const CRASH_DIR: &str = "crash-state";
const LAUNCHED_FLAG: &str = "launched.flag";
const CLEAN_EXIT_FLAG: &str = "clean-exit.flag";

fn main() {
    install_panic_hook();

    tauri::Builder::default()
        // 单实例须最先注册：二次启动聚焦已有窗口，并把启动参数转给首实例（§4.2）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // 双击 .agtp 二次启动：壳侧先暂存路径，前端二期接入时即插即用（§4.3）
            if let Some(path) = extract_agtp_arg(&argv) {
                let _ = write_pending_open(app, &path);
            }
        }))
        // 壳侧日志（M1）：stdout + 按日轮转文件（本地时区），保留 7 天（§3.4 P7 / §5.1）
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    logging::daily_file_target(),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        // 窗口几何记忆：大小/位置/最大化（§4.1）
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // sidecar spawn 能力（§6，壳侧储备：前端零改动下无调用方，备好不破坏现状）
        .plugin(tauri_plugin_shell::init())
        // 自动更新（§8.3，minisign 强制校验；检查入口在壳侧 updater.rs。
        // Windows 上安装器装完自动重启应用，无需 process 插件）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // 四类储备 command（§3.3）：路径查询 / 凭据读写 / fetch 代理 / spawn 转发
            commands::paths_get,
            commands::secrets_set,
            commands::secrets_get,
            commands::secrets_delete,
            commands::llm_fetch,
            commands::sidecar_run,
            commands::sidecar_cancel,
            commands::download_model,
            // 壳侧辅助
            commands::taskbar_progress,
            commands::diagnostics_export,
            commands::pending_open_take,
        ])
        .setup(|app| {
            on_startup(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri 构建上下文初始化失败")
        .run(|app, event| {
            // 正常退出落“干净退出”标记；下次启动发现标记缺失 = 上次异常退出（§5.4）
            if let tauri::RunEvent::Exit = event {
                mark_clean_exit(app);
            }
        });
}

fn on_startup(app: &tauri::AppHandle) {
    let data_dir = app_data_dir(app);
    let _ = fs::create_dir_all(data_dir.join("logs"));
    let _ = fs::create_dir_all(data_dir.join(CRASH_DIR));

    log::info!(
        "启动 {} v{} @ {}（{}）",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        IDENTIFIER,
        os_info::get()
    );

    // --diagnostics 短路入口（§5.4）：导出诊断包 → 原生提示（后台线程，不阻塞启动）
    if std::env::args().any(|a| a == "--diagnostics") {
        let app2 = app.clone();
        thread::spawn(move || match diagnostics::diagnostics_export_impl(&app2) {
            Ok(zip) => {
                native::msg_box(
                    native::MB_INFO,
                    "AI 智能扒谱 · 诊断包",
                    &format!("诊断包已导出：\n{zip}\n\n（仅含日志、版本与系统信息，不含密钥与音频）"),
                    false,
                );
            }
            Err(e) => {
                native::msg_box(
                    native::MB_ERROR,
                    "AI 智能扒谱 · 诊断包",
                    &format!("诊断包导出失败：{e}"),
                    false,
                );
            }
        });
    }

    // 崩溃检测（§5.4）：上次有启动标记但无“正常退出”标记 → 异常退出
    let launched = data_dir.join(CRASH_DIR).join(LAUNCHED_FLAG);
    let clean = data_dir.join(CRASH_DIR).join(CLEAN_EXIT_FLAG);
    let crashed_last_run = launched.exists() && !clean.exists();
    let _ = fs::remove_file(&clean);
    if let Err(e) = fs::write(&launched, unix_ts().to_string()) {
        log::warn!("写入启动标记失败：{e}");
    }
    if crashed_last_run {
        log::warn!("检测到上次异常退出，将提示导出诊断包");
        let app2 = app.clone();
        thread::spawn(move || {
            if native::msg_box(
                native::MB_WARN,
                "AI 智能扒谱",
                "上次似乎异常退出了。\n\n是否导出诊断包（日志 + 版本 + 系统信息，不含密钥与音频）以便反馈问题？",
                true,
            ) {
                match diagnostics::diagnostics_export_impl(&app2) {
                    Ok(zip) => {
                        if let Some(dir) = Path::new(&zip).parent() {
                            let _ = open_in_explorer(dir);
                        }
                    }
                    Err(e) => log::error!("诊断包导出失败：{e}"),
                }
            }
        });
    }

    // 双击 .agtp 首次启动：暂存路径（自动载入工程属二期，§4.3 零改动边界）
    if let Some(path) = extract_agtp_arg(&std::env::args().collect::<Vec<_>>()) {
        let _ = write_pending_open(app, &path);
    }

    // 启动时检查更新（§8.3：默认关闭；settings.json 的 checkUpdatesOnStartup 控制）
    if read_check_updates_flag(&data_dir) {
        let app2 = app.clone();
        thread::spawn(move || updater::check_update_and_prompt(&app2));
    }
}

fn mark_clean_exit(app: &tauri::AppHandle) {
    let clean = app_data_dir(app).join(CRASH_DIR).join(CLEAN_EXIT_FLAG);
    if let Err(e) = fs::write(&clean, unix_ts().to_string()) {
        eprintln!("写入退出标记失败：{e}");
    }
    log::info!("正常退出");
}

// ---------- panic 兜底（§5.4：Rust 侧 panic hook 写日志） ----------
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("panic: {info}");
        log::error!("{msg}");
        // 日志通道可能随 panic 一起失效：同时直写崩溃目录兜底
        if let Some(dir) = std::env::var("APPDATA").ok().map(|d| {
            PathBuf::from(d).join(IDENTIFIER).join(CRASH_DIR)
        }) {
            let _ = fs::create_dir_all(&dir);
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("panic.log"))
                .and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "[{}] {msg}", unix_ts())
                });
        }
    }));
}

// ---------- .agtp 启动参数 → pending-open.json（§4.3） ----------
fn extract_agtp_arg(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .skip(1)
        .map(Path::new)
        .find(|p| {
            p.extension()
                .map(|e| e.eq_ignore_ascii_case("agtp"))
                .unwrap_or(false)
                && p.is_file()
        })
        .map(Path::to_path_buf)
}

fn write_pending_open(app: &tauri::AppHandle, path: &Path) -> std::io::Result<()> {
    let file = app_data_dir(app).join("pending-open.json");
    log::info!("暂存待打开工程：{}", path.display());
    serde_json::to_writer_pretty(
        &fs::File::create(file)?,
        &serde_json::json!({ "path": path, "receivedAt": unix_ts() }),
    )
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
}

fn read_check_updates_flag(data_dir: &Path) -> bool {
    let Ok(v) = fs::read_to_string(data_dir.join("settings.json")) else {
        return false; // 默认不自动检查（§8.3：尊重用户对生产工具的控制感）
    };
    serde_json::from_str::<serde_json::Value>(&v)
        .ok()
        .and_then(|v| v.get("checkUpdatesOnStartup").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

// ---------- 小工具 ----------
pub fn app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| fallback_app_data_dir())
}

pub fn fallback_app_data_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join(IDENTIFIER)
}

pub fn unix_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 路径转字符串（Windows 下统一 lossy 转换，供 IPC 返回值使用）
pub fn display_path(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn open_in_explorer(dir: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("explorer")
        .arg(dir)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}
