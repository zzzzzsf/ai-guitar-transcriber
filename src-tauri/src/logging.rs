// 壳侧日志：按日轮转文件 target，保留 7 天（§3.4 P7 / §5.1）
// 经 tauri-plugin-log 的 Dispatch 扩展点接入（该插件无 Custom target）

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use tauri_plugin_log::{Target, TargetKind};

pub fn daily_file_target() -> Target {
    // 文件名 app-YYYY-MM-DD.log（本地时区），跨日自动切换 + 清理 7 天前的旧文件
    struct DailyFile(Mutex<Option<(String, std::fs::File)>>);
    impl DailyFile {
        fn rollover_if_needed(&self) {
            let today = today_str();
            let mut guard = self.0.lock().unwrap();
            let stale = guard.as_ref().map(|(d, _)| d != &today).unwrap_or(true);
            if stale {
                let dir = crate::fallback_app_data_dir().join("logs");
                let _ = std::fs::create_dir_all(&dir);
                *guard = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join(format!("app-{today}.log")))
                    .ok()
                    .map(|f| (today, f));
                prune_old_logs(&dir); // 保留 7 天封顶
            }
        }
    }
    impl Write for DailyFile {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.rollover_if_needed();
            match self.0.lock().unwrap().as_mut() {
                Some((_, f)) => f.write(buf),
                None => Ok(buf.len()), // 文件不可用时丢弃（stdout target 仍有输出）
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            match self.0.lock().unwrap().as_mut() {
                Some((_, f)) => f.flush(),
                None => Ok(()),
            }
        }
    }

    Target::new(TargetKind::Dispatch(
        fern::Dispatch::new().chain(fern::Output::writer(
            Box::new(DailyFile(Mutex::new(None))),
            "\n",
        )),
    ))
}

/// 本地时区当日日期（Windows GetLocalTime，无时区换算依赖）
pub(crate) fn today_str() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut st = SYSTEMTIME {
        wYear: 0,
        wMonth: 0,
        wDayOfWeek: 0,
        wDay: 0,
        wHour: 0,
        wMinute: 0,
        wSecond: 0,
        wMilliseconds: 0,
    };
    unsafe { GetLocalTime(&mut st) };
    format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay)
}

fn prune_old_logs(dir: &Path) {
    const KEEP_DAYS: usize = 7;
    let mut logs: Vec<(String, std::time::SystemTime)> = std::fs::read_dir(dir)
        .ok()
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.starts_with("app-") && n.ends_with(".log")
                })
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (n, t))
                })
                .collect()
        })
        .unwrap_or_default();
    if logs.len() <= KEEP_DAYS {
        return;
    }
    logs.sort_by_key(|(_, t)| *t); // 最旧在前
    let excess = logs.len() - KEEP_DAYS;
    for (name, _) in logs.into_iter().take(excess) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}
