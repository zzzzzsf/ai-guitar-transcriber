// 启动时更新检查（§8.3：默认关，settings.json > checkUpdatesOnStartup 开启；
// minisign 强制校验在 updater 插件内，失败即拒装——W8）。纯壳侧，不经前端。

use tauri::AppHandle;

use crate::native::{msg_box, MB_ERROR, MB_WARN};

pub fn check_update_and_prompt(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater_builder().build() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("updater 初始化失败：{e}");
            return;
        }
    };
    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(u)) => u,
        Ok(None) => {
            log::info!("已是最新版本");
            return;
        }
        Err(e) => {
            log::warn!("检查更新失败：{e}");
            return; // 网络问题不打扰用户
        }
    };
    log::info!("发现新版本 {}", update.version);
    if msg_box(
        MB_WARN,
        "AI 智能扒谱 · 更新",
        &format!(
            "发现新版本 {}，是否现在下载并安装？\n\n（更新包经 minisign 签名校验）",
            update.version
        ),
        true,
    ) {
        let mut downloaded = 0u64;
        // Windows：安装器装完自动重启应用（updater 默认 restart_after_install）
        match tauri::async_runtime::block_on(update.download_and_install(
            |chunk, _| downloaded += chunk as u64,
            || {},
        )) {
            Ok(()) => log::info!("更新安装完成（{downloaded} 字节），安装器将重启应用"),
            Err(e) => {
                log::error!("更新安装失败：{e}");
                let _ = msg_box(MB_ERROR, "AI 智能扒谱 · 更新", &format!("更新安装失败：{e}"), false);
            }
        }
    }
}
