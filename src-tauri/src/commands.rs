// 全部 IPC command 收敛在此（方案 §3.3：fetch 代理 / 凭据读写 / spawn 转发 / 路径查询 四类，
// 全部作为储备先就位——前端零改动下无调用方，二期接入时即插即用），其余逻辑维持在前端。
// 非命令的壳侧实现分模块：logging.rs（日志轮转）/ diagnostics.rs（诊断包）/
// download.rs（模型下载内部实现）/ updater.rs（更新检查）/ native.rs（消息框）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

use crate::{app_data_dir, display_path, download};

// ============================================================
// 路径查询（§5.1 目标态口径：一期 WebView2 localStorage 持久化已可用）
// ============================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsInfo {
    pub app_data_dir: String,        // %APPDATA%\com.dsh.guitar：设置/工程索引/日志
    pub local_app_data_dir: String,  // %LOCALAPPDATA%\com.dsh.guitar：模型/缓存
    pub models_dir: String,          // 模型权重（§6.2）
    pub cache_dir: String,
    pub logs_dir: String,
    pub pending_open_path: String,   // 双击 .agtp 暂存（§4.3）
    pub documents_dir: Option<String>, // 默认工程目录 文档\AI扒谱 的上级（§5.1）
}

pub(crate) fn local_data_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
        .join(crate::IDENTIFIER)
}

#[tauri::command]
pub fn paths_get(app: AppHandle) -> Result<PathsInfo, String> {
    let data = app_data_dir(&app);
    let local = local_data_dir();
    Ok(PathsInfo {
        app_data_dir: display_path(&data),
        local_app_data_dir: display_path(&local),
        models_dir: display_path(&local.join("models")),
        cache_dir: display_path(&local.join("cache")),
        logs_dir: display_path(&data.join("logs")),
        pending_open_path: display_path(&data.join("pending-open.json")),
        documents_dir: app.path().document_dir().ok().map(|p| display_path(&p)),
    })
}

#[tauri::command]
pub fn pending_open_take(app: AppHandle) -> Result<Option<String>, String> {
    // 二期前端接入点：读到即清空（一次性消费）
    let p = app_data_dir(&app).join("pending-open.json");
    if !p.exists() {
        return Ok(None);
    }
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&p);
    Ok(v.get("path").and_then(|x| x.as_str()).map(String::from))
}

// ============================================================
// 凭据读写（§7.2：Windows 凭据管理器；W10 四步验收 写入→重启→读回→删除）
// 现状前端 BYOK Key 仅会话内存绝不落盘——本 command 为二期迁移落点，先备好。
// ============================================================

const KEYRING_SERVICE: &str = crate::IDENTIFIER;

pub(crate) fn keyring_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("凭据管理器初始化失败：{e}"))
}

#[tauri::command]
pub fn secrets_set(key: String, value: String) -> Result<(), String> {
    keyring_entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secrets_get(key: String) -> Result<Option<String>, String> {
    match keyring_entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secrets_delete(key: String) -> Result<(), String> {
    match keyring_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ============================================================
// BYOK 主进程代理（§7.1：密钥不进前端、统一脱敏日志；SSE 走 IPC channel）
// 零改动现状：前端 llmClient.ts 直连 fetch 在 WebView2 内原样可用；
// 本代理是二期切换目标。脱敏纪律：Authorization 与请求/响应体永不落日志。
// ============================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequest {
    pub url: String,
    pub method: Option<String>, // 缺省 POST
    pub headers: Option<HashMap<String, String>>, // 调用方除 Authorization 外的头
    pub body: Option<String>,
    /// keyring 槽位名——密钥从凭据管理器取，不经过前端 JS 堆（§7.1 主因）
    pub bearer_secret_key: Option<String>,
    pub stream: Option<bool>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn llm_fetch(
    req: LlmRequest,
    on_chunk: Channel<serde_json::Value>,
) -> Result<LlmResponse, String> {
    let method = reqwest::Method::from_bytes(
        req.method.clone().unwrap_or_else(|| "POST".into()).as_bytes(),
    )
    .map_err(|_| format!("非法 HTTP 方法：{}", req.method.unwrap_or_default()))?;

    let mut request = reqwest::Client::new()
        .request(method.clone(), &req.url)
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(120_000)));

    if let Some(slot) = &req.bearer_secret_key {
        let key = keyring_entry(slot)?
            .get_password()
            .map_err(|e| format!("读取凭据「{slot}」失败：{e}"))?;
        request = request.bearer_auth(key);
    }
    for (k, v) in req.headers.clone().unwrap_or_default() {
        request = request.header(&k, v);
    }
    if let Some(b) = &req.body {
        request = request.body(b.clone());
    }

    let resp = request.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let is_event_stream = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false);
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();

    let mut body = String::new();
    if req.stream.unwrap_or(false) && is_event_stream {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("流中断：{e}"))?;
            let text = String::from_utf8_lossy(&chunk).to_string();
            let _ = on_chunk.send(serde_json::json!({ "event": "chunk", "delta": text }));
            body.push_str(&text);
        }
    } else {
        body = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    }
    // 脱敏日志：只有方法/URL/状态码（§7.1）
    log::info!("llm_proxy {} {} -> {status}", method, req.url);
    Ok(LlmResponse { status, headers, body })
}

// ============================================================
// Sidecar 转发（§6.3：stdout/stderr 流式回传 IPC event、杀进程树、防休眠）
// demucs.cpp 二进制按 M3 落地（见 binaries/README.md）；command 先备好。
// ============================================================

static SIDECAR_RUNS: Mutex<Option<HashMap<u64, u32>>> = Mutex::new(None);
static SIDECAR_NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub async fn sidecar_run(
    app: AppHandle,
    name: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<u64, String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    let mut cmd = app.shell().sidecar(&name).map_err(|e| {
        format!("sidecar「{name}」不可用：{e}（M3 后随包分发，见 src-tauri/binaries/README.md）")
    })?;
    if let Some(dir) = &cwd {
        cmd = cmd.current_dir(dir);
    }
    for a in args {
        cmd = cmd.arg(a);
    }

    let run_id = SIDECAR_NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("启动 sidecar 失败：{e}"))?;
    SIDECAR_RUNS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(run_id, child.pid());
    log::info!("sidecar[{run_id}] {name} 启动（pid={}）", child.pid());

    let app = app.clone();
    let name_for_task = name.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            // stdout/stderr 都尝试解析进度：不少 CLI（demucs 类）把进度打到 stderr
            let (stream, data) = match ev {
                CommandEvent::Stdout(line) => {
                    keep_awake_tick(); // 防休眠（§6.3）：活动即重置系统空闲计时
                    update_taskbar_from_line(&app, &line); // P8：任务栏进度（不经前端）
                    ("stdout", String::from_utf8_lossy(&line).to_string())
                }
                CommandEvent::Stderr(line) => {
                    keep_awake_tick();
                    update_taskbar_from_line(&app, &line);
                    ("stderr", String::from_utf8_lossy(&line).to_string())
                }
                CommandEvent::Terminated(payload) => {
                    ("exit", payload.code.map_or_else(|| "-1".into(), |c| c.to_string()))
                }
                CommandEvent::Error(e) => ("error", e.to_string()),
                _ => continue,
            };
            let _ = app.emit(
                "sidecar:event",
                serde_json::json!({ "runId": run_id, "name": name_for_task, "stream": stream, "data": data }),
            );
        }
        SIDECAR_RUNS.lock().unwrap().get_or_insert_with(HashMap::new).remove(&run_id);
        if let Some(w) = app.get_webview_window("main") {
            set_taskbar(&w, None); // P8：任务结束清进度条
        }
    });
    Ok(run_id)
}

#[tauri::command]
pub fn sidecar_cancel(run_id: u64) -> Result<(), String> {
    let pid = SIDECAR_RUNS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .remove(&run_id);
    if let Some(pid) = pid {
        kill_process_tree(pid)
    } else {
        Ok(()) // 已退出，视为取消成功
    }
}

/// Windows 杀进程树：taskkill /T /F 语义（§6.3——否则孙进程残留占着模型内存）
fn kill_process_tree(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID"])
        .arg(pid.to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill 执行失败：{e}"))?;
    log::info!(
        "杀进程树 pid={pid}：{}",
        String::from_utf8_lossy(&out.stdout).trim()
    );
    Ok(())
}

/// 防休眠（§6.3 可选项）：一次性 ES_SYSTEM_REQUIRED 重置空闲计时器即可，
/// 不用 ES_CONTINUOUS（async 任务会在线程间跳，线程持续标志位不可靠）。
fn keep_awake_tick() {
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    unsafe { windows_sys::Win32::System::Power::SetThreadExecutionState(ES_SYSTEM_REQUIRED) };
}

/// P8：从 sidecar 输出行里解析 "NN%" 进度 → 任务栏进度条（窗口最小化时可见）
fn update_taskbar_from_line(app: &AppHandle, line: &[u8]) {
    let text = String::from_utf8_lossy(line);
    let Some(pct) = parse_percent(&text) else { return };
    if let Some(w) = app.get_webview_window("main") {
        set_taskbar(&w, Some(pct / 100.0));
    }
}

/// 从一行文本解析末尾的 "NN%"（demucs.cpp 等常见 CLI 进度样式）
fn parse_percent(text: &str) -> Option<f64> {
    let idx = text.rfind('%')?;
    let digits: String = text[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let n: f64 = digits.parse().ok()?;
    (0.0..=100.0).contains(&n).then_some(n)
}

fn set_taskbar(w: &tauri::WebviewWindow, progress: Option<f64>) {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    let state = match progress {
        Some(p) => ProgressBarState {
            status: Some(ProgressBarStatus::Normal),
            progress: Some((p * 100.0).round() as u64),
        },
        None => ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        },
    };
    let _ = w.set_progress_bar(state);
}

/// P8：任务栏进度 command（前端二期也可直接调；progress 取 0.0~1.0，None 清除）
#[tauri::command]
pub fn taskbar_progress(app: AppHandle, progress: Option<f64>) -> Result<(), String> {
    if let Some(p) = progress {
        if !(0.0..=1.0).contains(&p) {
            return Err("progress 取值须在 0.0~1.0".into());
        }
    }
    let w = app.get_webview_window("main").ok_or("主窗口不存在")?;
    set_taskbar(&w, progress);
    Ok(())
}

// ============================================================
// 模型权重下载 command（§6.2；实现见 download.rs）
// 权重不进安装包，首用下载到 %LOCALAPPDATA%\com.dsh.guitar\models\
// ============================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub name: String,
    pub urls: Vec<String>, // 主源 + 镜像备选列表，按序降级（§6.2 ②）
    pub sha256: String,    // hex；镜像不可投毒的保证（§6.2 ②）
    pub size: Option<u64>,
}

#[tauri::command]
pub async fn download_model(
    spec: ModelSpec,
    on_progress: Channel<serde_json::Value>,
) -> Result<String, String> {
    let models_dir = local_data_dir().join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    let final_path = models_dir.join(&spec.name);
    let expected = hex::decode(spec.sha256.trim().to_ascii_lowercase())
        .map_err(|_| "sha256 字段不是合法 hex".to_string())?;

    // 已就绪则直接返回（幂等）
    if final_path.is_file() {
        if download::file_sha256(&final_path).map_err(|e| e.to_string())? == expected[..] {
            return Ok(display_path(&final_path));
        }
        let _ = std::fs::remove_file(&final_path); // 损坏即重下
    }

    // reqwest 默认开启 system-proxy：遵循系统环境变量与注册表代理（§6.2 ①）
    let client = reqwest::Client::new();
    let part = models_dir.join(format!("{}.part", spec.name));
    let mut last_err = String::new();
    for (i, url) in spec.urls.iter().enumerate() {
        match download::download_once(&client, url, &part, &expected, spec.size, &on_progress).await {
            Ok(()) => {
                std::fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
                let _ = on_progress.send(serde_json::json!({ "done": true, "path": display_path(&final_path) }));
                log::info!("模型 {} 下载完成（源 {}）", spec.name, i + 1);
                return Ok(display_path(&final_path));
            }
            Err(e) => {
                // 重试 + 人类可读错误（§6.2 ③）；断点保留，下一源续传
                last_err = e;
                log::warn!("模型下载源 {} 失败：{last_err}", i + 1);
            }
        }
    }
    Err(format!("全部下载源均失败：{last_err}。请检查网络或系统代理后重试（已下载部分会续传）。"))
}

// ============================================================
// 诊断包 command（§5.4；实现见 diagnostics.rs）
// ============================================================

#[tauri::command]
pub fn diagnostics_export(app: AppHandle) -> Result<String, String> {
    crate::diagnostics::diagnostics_export_impl(&app)
}
