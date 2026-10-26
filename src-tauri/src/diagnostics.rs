// 诊断包（§5.4：一键 zip = 壳侧日志 + 版本号 + 系统信息；不含密钥与音频）
// IPC command 入口在 commands.rs（diagnostics_export）。

use std::io::Write;
use tauri::AppHandle;

use crate::{app_data_dir, display_path, unix_ts};

pub fn diagnostics_export_impl(app: &AppHandle) -> Result<String, String> {
    let data_dir = app_data_dir(app);
    let logs_dir = data_dir.join("logs");
    let out_dir = data_dir.join("diagnostics");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let zip_path = out_dir.join(format!("diagnostics-{}.zip", unix_ts()));
    log::info!("导出诊断包 -> {}", zip_path.display());

    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("info.txt", opts).map_err(zerr)?;
    writeln!(
        zip,
        "app={} version={} identifier={}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        crate::IDENTIFIER
    )
    .map_err(|e| e.to_string())?;
    writeln!(zip, "os={}", os_info::get()).map_err(|e| e.to_string())?;
    writeln!(zip, "exported_at={}", unix_ts()).map_err(|e| e.to_string())?;

    if logs_dir.is_dir() {
        for entry in std::fs::read_dir(&logs_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().map(|e| e == "log").unwrap_or(false) {
                zip.start_file(format!("logs/{}", entry.file_name().to_string_lossy()), opts)
                    .map_err(zerr)?;
                let mut src = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                std::io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;
            }
        }
    }
    zip.finish().map_err(zerr)?;
    Ok(display_path(&zip_path))
}

fn zerr(e: zip::result::ZipError) -> String {
    e.to_string()
}
