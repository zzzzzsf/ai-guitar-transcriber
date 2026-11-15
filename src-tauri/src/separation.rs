//! 分轨 command：WebView 传入音频字节与档位，Rust 在应用缓存目录内
//! 落盘、调用 externalBin、收集 stems 并清理工作目录。
//!
//! 对外契约见 app/src/main/desktopSeparation.ts。真实分轨二进制缺失时返回
//! 可读错误；前端 TierRouter 按既定策略回落轻量档，不在这里静默伪装成功。

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::commands::{keep_awake_tick, kill_process_tree, set_taskbar};
use crate::download;

pub const SEPARATOR_NAME: &str = "demucs";
const STEM_NAMES: [&str; 6] = ["guitar", "bass", "drums", "vocals", "piano", "other"];
const FINISHED_RUN_HISTORY: usize = 256;

static RUN_STATE: Mutex<Option<RunState>> = Mutex::new(None);
#[cfg(test)]
static NEXT_TEST_DIR_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct RunState {
    active: HashSet<u64>,
    pids: HashMap<u64, u32>,
    cancelled: HashSet<u64>,
    finished: HashSet<u64>,
    finished_order: VecDeque<u64>,
}

struct RunCompletionGuard {
    run_id: u64,
    finished: bool,
}

impl RunCompletionGuard {
    fn new(run_id: u64) -> Self {
        Self { run_id, finished: false }
    }

    fn finish(&mut self) -> bool {
        self.finished = true;
        finish_run(self.run_id)
    }
}

impl Drop for RunCompletionGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = finish_run(self.run_id);
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationRequest {
    pub run_id: u64,
    pub tier: String,
    /// WebView 传入 base64，避免把数 MB 音频展开成 JSON 数字数组
    pub input_bytes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationResponse {
    pub stems: BTreeMap<String, String>,
    pub work_dir: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeparationArgs {
    pub input: String,
    pub output: String,
    pub model: String,
    pub segment: String,
    pub quantization: Option<String>,
    pub overlap: Option<String>,
}

impl SeparationArgs {
    pub fn as_vec(&self) -> Vec<String> {
        let mut args = vec![
            "--input".into(),
            self.input.clone(),
            "--output".into(),
            self.output.clone(),
            "--model".into(),
            self.model.clone(),
            "--segment".into(),
            self.segment.clone(),
        ];
        if let Some(quantization) = &self.quantization {
            args.extend(["--quantization".into(), quantization.clone()]);
        }
        if let Some(overlap) = &self.overlap {
            args.extend(["--overlap".into(), overlap.clone()]);
        }
        args
    }
}

/// 与 app/src/main/separatorRunner.ts 的三档参数保持同一 CLI 契约。
pub fn separation_args(tier: &str, input: &Path, output: &Path) -> Result<SeparationArgs, String> {
    let (segment, quantization, overlap) = match tier {
        "balanced" => ("3", Some("int8".into()), None),
        "pro" => ("10", None, Some("high".into())),
        _ => return Err(format!("不支持的分轨档位：{tier}")),
    };
    Ok(SeparationArgs {
        input: input.to_string_lossy().into_owned(),
        output: output.to_string_lossy().into_owned(),
        model: "htdemucs_6s".into(),
        segment: segment.into(),
        quantization,
        overlap,
    })
}

/// Include the run ID so different tasks never share and clean the same work
/// directory for identical audio/tier inputs.
pub fn separation_work_dir_name(tier: &str, hash: &str, run_id: u64) -> String {
    format!("{tier}-{hash}-{run_id}")
}

#[tauri::command]
pub fn separator_available(app: AppHandle) -> bool {
    app.shell().sidecar(SEPARATOR_NAME).is_ok()
}

#[tauri::command]
pub async fn separation_run(
    app: AppHandle,
    request: SeparationRequest,
    on_progress: Channel<serde_json::Value>,
) -> Result<SeparationResponse, String> {
    let started = std::time::Instant::now();
    let run_id = request.run_id;
    // A cancellation can arrive over IPC just before this command starts.
    // Consume it before validation or filesystem work so it cannot be left
    // behind when an early validation error returns.
    if let Err(error) = begin_run(run_id) {
        return Err(error);
    }
    let mut completion = RunCompletionGuard::new(run_id);
    if request.input_bytes.is_empty() {
        return Err("音频输入为空".into());
    }
    let input_bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.input_bytes)
        .map_err(|e| format!("音频 base64 解码失败：{e}"))?;
    if input_bytes.is_empty() {
        return Err("音频输入为空".into());
    }
    separation_args(&request.tier, Path::new("input.wav"), Path::new(""))?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位应用缓存目录：{e}"))?
        .join("separation");
    std::fs::create_dir_all(&root).map_err(|e| format!("创建分轨缓存目录失败：{e}"))?;
    let hash = hex::encode(download::sha256_bytes(&input_bytes));
    let work = root.join(separation_work_dir_name(&request.tier, &hash, run_id));
    if work.exists() {
        cleanup(&work);
    }
    std::fs::create_dir_all(&work).map_err(|e| format!("创建分轨工作目录失败：{e}"))?;
    let input = work.join("input.wav");
    std::fs::write(&input, input_bytes).map_err(|e| format!("写入输入音频失败：{e}"))?;
    let output = work.join("stems");
    std::fs::create_dir_all(&output).map_err(|e| format!("创建分轨输出目录失败：{e}"))?;

    let actual_args = separation_args(&request.tier, &input, &output)?;
    let mut cmd = app.shell().sidecar(SEPARATOR_NAME).map_err(|e| {
        cleanup(&work);
        format!("分轨程序不可用：{e}（安装包缺少 demucs externalBin）")
    })?;
    cmd = cmd
        .current_dir(&work)
        .set_process_group(true)
        .args(actual_args.as_vec());
    let (mut rx, child) = cmd.spawn().map_err(|e| {
        cleanup(&work);
        format!("启动分轨程序失败：{e}")
    })?;
    let pid = child.pid();
    if !register_pid(run_id, pid) {
        let _ = kill_process_tree(pid);
        cleanup(&work);
        return Err("分轨已取消".into());
    }
    let _ = on_progress.send(serde_json::json!({ "runId": run_id, "phase": "started" }));

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                keep_awake_tick();
                let text = String::from_utf8_lossy(&line).to_string();
                stdout.push_str(&text);
                stdout.push('\n');
                emit_progress(&app, run_id, "stdout", &text, &on_progress);
            }
            CommandEvent::Stderr(line) => {
                keep_awake_tick();
                let text = String::from_utf8_lossy(&line).to_string();
                stderr.push_str(&text);
                stderr.push('\n');
                emit_progress(&app, run_id, "stderr", &text, &on_progress);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Error(error) => {
                stderr.push_str(&error);
                stderr.push('\n');
            }
            _ => {}
        }
    }
    // Atomically close the run before collecting results. A later cancel is
    // ignored instead of leaving a stale token for a completed run ID.
    let cancelled = completion.finish();
    if let Some(window) = app.get_webview_window("main") {
        set_taskbar(&window, None);
    }
    let result = if cancelled {
        Err("分轨已取消".into())
    } else {
        match exit_code {
            Some(0) => collect_stems(&output)
                .and_then(|stems| encode_stems(&stems))
                .map(|encoded| SeparationResponse {
                    stems: encoded,
                    work_dir: format!("desktop-separation/{run_id}"),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                }),
            Some(code) => Err(format!(
                "分轨进程退出码 {code}：{}",
                stderr.trim().chars().take(300).collect::<String>()
            )),
            None => Err(format!(
                "分轨进程未返回退出码：{}",
                stderr.trim().chars().take(300).collect::<String>()
            )),
        }
    };
    let _ = app.emit(
        "sidecar:event",
        serde_json::json!({
            "runId": run_id,
            "name": SEPARATOR_NAME,
            "stream": "exit",
            "data": exit_code.unwrap_or(-1).to_string(),
        }),
    );
    cleanup(&work);
    result
}

#[tauri::command]
pub fn cancel_separation(run_id: u64) -> Result<(), String> {
    match request_cancel(run_id) {
        Some(pid) => kill_process_tree(pid),
        None => Ok(()),
    }
}

fn begin_run(run_id: u64) -> Result<(), String> {
    let mut state = RUN_STATE.lock().unwrap();
    let state = state.get_or_insert_with(RunState::default);
    if state.finished.contains(&run_id) || state.active.contains(&run_id) {
        return Err("分轨任务 ID 冲突".into());
    }
    if state.cancelled.remove(&run_id) {
        record_finished(state, run_id);
        return Err("分轨已取消".into());
    }
    state.active.insert(run_id);
    Ok(())
}

fn register_pid(run_id: u64, pid: u32) -> bool {
    let mut state = RUN_STATE.lock().unwrap();
    let state = state.get_or_insert_with(RunState::default);
    if !state.active.contains(&run_id) || state.cancelled.contains(&run_id) {
        return false;
    }
    state.pids.insert(run_id, pid);
    true
}

fn request_cancel(run_id: u64) -> Option<u32> {
    let mut state = RUN_STATE.lock().unwrap();
    let state = state.get_or_insert_with(RunState::default);
    if state.finished.contains(&run_id) {
        return None;
    }
    state.cancelled.insert(run_id);
    state.pids.get(&run_id).copied()
}

fn finish_run(run_id: u64) -> bool {
    let mut state = RUN_STATE.lock().unwrap();
    let state = state.get_or_insert_with(RunState::default);
    let cancelled = state.cancelled.remove(&run_id);
    state.active.remove(&run_id);
    state.pids.remove(&run_id);
    record_finished(state, run_id);
    cancelled
}

fn record_finished(state: &mut RunState, run_id: u64) {
    if state.finished.insert(run_id) {
        state.finished_order.push_back(run_id);
        while state.finished_order.len() > FINISHED_RUN_HISTORY {
            if let Some(expired) = state.finished_order.pop_front() {
                state.finished.remove(&expired);
            }
        }
    }
}

fn emit_progress(
    app: &AppHandle,
    run_id: u64,
    stream: &str,
    line: &str,
    channel: &Channel<serde_json::Value>,
) {
    let payload = serde_json::json!({
        "runId": run_id,
        "name": SEPARATOR_NAME,
        "stream": stream,
        "data": line,
    });
    let _ = app.emit("sidecar:event", payload.clone());
    let _ = channel.send(payload);
}

fn collect_stems(root: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    let mut found = BTreeMap::new();
    let mut queue = vec![root.to_path_buf()];
    for _ in 0..3 {
        if queue.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for dir in queue {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    next.push(path);
                } else if let Some(stem) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(str::to_ascii_lowercase)
                {
                    if STEM_NAMES.contains(&stem.as_str()) {
                        found.entry(stem).or_insert(path);
                    }
                }
            }
        }
        queue = next;
    }
    if !found.contains_key("guitar") {
        return Err(format!(
            "分轨产物缺少 guitar.wav（已发现：{}）",
            if found.is_empty() {
                "无".to_string()
            } else {
                found.keys().cloned().collect::<Vec<_>>().join(", ")
            }
        ));
    }
    Ok(found)
}

fn encode_stems(stems: &BTreeMap<String, PathBuf>) -> Result<BTreeMap<String, String>, String> {
    let engine = base64::engine::general_purpose::STANDARD;
    stems
        .iter()
        .map(|(name, path)| {
            let bytes = std::fs::read(path).map_err(|e| format!("读取 {name}.wav 失败：{e}"))?;
            Ok((name.clone(), engine.encode(bytes)))
        })
        .collect()
}

fn cleanup(path: &Path) {
#[cfg(not(windows))]
    let _ = std::fs::remove_dir_all(path);
#[cfg(windows)]
    {
        // 子进程刚退出时 Windows 可能短暂占用输出句柄；退避重试，避免残留缓存。
        for attempt in 0..8 {
            if std::fs::remove_dir_all(path).is_ok() || !path.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25 << attempt.min(4)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_match_balanced_cli_contract() {
        let args = separation_args("balanced", Path::new("in.wav"), Path::new("out")).unwrap();
        let raw = args.as_vec();
        assert_eq!(args.segment, "3");
        assert_eq!(args.quantization.as_deref(), Some("int8"));
        assert_eq!(args.overlap, None);
        assert_eq!(raw[raw.iter().position(|x| x == "--input").unwrap() + 1], "in.wav");
    }

    #[test]
    fn args_match_pro_cli_contract() {
        let args = separation_args("pro", Path::new("in.wav"), Path::new("out")).unwrap();
        assert_eq!(args.segment, "10");
        assert_eq!(args.quantization, None);
        assert_eq!(args.overlap.as_deref(), Some("high"));
    }

    #[test]
    fn rejects_light_tier_and_unknown_tier() {
        assert!(separation_args("light", Path::new("in.wav"), Path::new("out")).is_err());
        assert!(separation_args("unknown", Path::new("in.wav"), Path::new("out")).is_err());
    }

    #[test]
    fn collect_requires_guitar_stem() {
        let dir = std::env::temp_dir().join(format!(
            "agtp-stems-{}",
            NEXT_TEST_DIR_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bass.wav"), b"bass").unwrap();
        assert!(collect_stems(&dir).unwrap_err().contains("guitar.wav"));
        std::fs::write(dir.join("guitar.wav"), b"guitar").unwrap();
        let stems = collect_stems(&dir).unwrap();
        assert_eq!(stems.get("guitar").unwrap(), &dir.join("guitar.wav"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cancel_before_start_is_consumed_and_marked_finished() {
        let run_id = 9_000_001;
        assert_eq!(request_cancel(run_id), None);
        assert!(begin_run(run_id).unwrap_err().contains("取消"));
        let state = RUN_STATE.lock().unwrap();
        let state = state.as_ref().unwrap();
        assert!(!state.cancelled.contains(&run_id));
        assert!(state.finished.contains(&run_id));
    }

    #[test]
    fn cancellation_during_spawn_is_seen_when_pid_is_registered() {
        let run_id = 9_000_002;
        begin_run(run_id).unwrap();
        assert_eq!(request_cancel(run_id), None);
        assert!(!register_pid(run_id, 4242));
        assert!(finish_run(run_id));
    }

    #[test]
    fn cancel_after_finished_run_does_not_leave_a_stale_token() {
        let run_id = 9_000_003;
        begin_run(run_id).unwrap();
        assert!(register_pid(run_id, 4243));
        assert!(!finish_run(run_id));
        assert_eq!(request_cancel(run_id), None);
        let state = RUN_STATE.lock().unwrap();
        let state = state.as_ref().unwrap();
        assert!(!state.cancelled.contains(&run_id));
        assert!(state.finished.contains(&run_id));
    }

    #[test]
    fn identical_audio_tasks_use_distinct_work_directories() {
        let tier = "balanced";
        let hash = "same-audio-hash";
        let a = separation_work_dir_name(tier, hash, 9_100_001);
        let b = separation_work_dir_name(tier, hash, 9_100_002);
        assert_ne!(a, b);
        assert!(a.starts_with(&format!("{tier}-{hash}-")));
        assert!(b.starts_with(&format!("{tier}-{hash}-")));
    }

    #[test]
    fn cancelled_task_does_not_remove_other_task_directory() {
        let root = std::env::temp_dir().join(format!(
            "agtp-work-isolation-{}",
            NEXT_TEST_DIR_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let shared_input = "identical-bytes";
        let hash = hex::encode(download::sha256_bytes(shared_input.as_bytes()));
        let survivor = root.join(separation_work_dir_name("balanced", &hash, 9_200_001));
        let cancelled = root.join(separation_work_dir_name("balanced", &hash, 9_200_002));
        std::fs::create_dir_all(&survivor).unwrap();
        std::fs::create_dir_all(&cancelled).unwrap();
        std::fs::write(survivor.join("guitar.wav"), b"survivor").unwrap();
        std::fs::write(cancelled.join("guitar.wav"), b"cancelled").unwrap();

        begin_run(9_200_001).unwrap();
        begin_run(9_200_002).unwrap();
        assert_eq!(request_cancel(9_200_002), None);
        assert!(finish_run(9_200_002));
        cleanup(&cancelled);

        assert_eq!(
            std::fs::read_to_string(survivor.join("guitar.wav")).unwrap(),
            "survivor"
        );
        assert!(!cancelled.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn collect_stems_does_not_read_across_task_directories() {
        let root = std::env::temp_dir().join(format!(
            "agtp-stem-isolation-{}",
            NEXT_TEST_DIR_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let other = root.join(separation_work_dir_name("balanced", "hash", 9_300_002));
        let ours = root.join(separation_work_dir_name("balanced", "hash", 9_300_001));
        std::fs::create_dir_all(other.join("stems")).unwrap();
        std::fs::create_dir_all(ours.join("stems")).unwrap();
        std::fs::write(other.join("stems/guitar.wav"), b"other-run").unwrap();
        std::fs::write(ours.join("stems/guitar.wav"), b"this-run").unwrap();

        let stems = collect_stems(&ours.join("stems")).unwrap();
        let encoded = encode_stems(&stems).unwrap();
        let payload = base64::engine::general_purpose::STANDARD
            .decode(encoded.get("guitar").unwrap())
            .unwrap();
        assert_eq!(payload, b"this-run");
        assert_eq!(stems.get("guitar").unwrap(), &ours.join("stems/guitar.wav"));
        let _ = std::fs::remove_dir_all(root);
    }
}
