// 模型权重下载内部实现（§6.2 三重保障：系统代理 / 镜像备选 / hash 校验；断点续传）
// IPC command 入口在 commands.rs（download_model）。

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

/// 单源下载：断点续传（Range），结束做 sha256 校验。
/// 校验失败删除断点整体重下（镜像不可投毒的保证）。
pub(crate) async fn download_once(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    expected: &[u8],
    size_hint: Option<u64>,
    on_progress: &Channel<serde_json::Value>,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(part)
        .map_err(|e| e.to_string())?;

    // 断点续传：先把已有 .part 部分喂给 hasher，再带 Range 请求
    if part.metadata().map(|m| m.len()).unwrap_or(0) > 0 {
        let mut existing = std::fs::File::open(part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = existing.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            downloaded += n as u64;
        }
    }

    let request = client.get(url);
    let request = if downloaded > 0 {
        request.header(reqwest::header::RANGE, format!("bytes={downloaded}-"))
    } else {
        request
    };
    let resp = request.send().await.map_err(|e| format!("连接失败：{e}"))?;

    // 416：.part 已是完整文件（上次在改名前中断）——直接校验现有内容
    if resp.status().as_u16() == 416 && downloaded > 0 {
        let digest: [u8; 32] = hasher.finalize().into();
        if digest == expected {
            return Ok(());
        }
        let _ = std::fs::remove_file(part);
        return Err("断点文件已完整但 hash 不符，已删除待重下".into());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    // 服务器不支持 Range（返回 200 全量）→ 从头再来
    if downloaded > 0 && resp.status().as_u16() != 206 {
        file.set_len(0).map_err(|e| e.to_string())?;
        hasher = Sha256::new();
        downloaded = 0;
    }
    let total = resp
        .content_length()
        .map(|c| c + downloaded)
        .or(size_hint)
        .unwrap_or(0);

    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("传输中断：{e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = std::time::Instant::now();
            let _ = on_progress.send(serde_json::json!({
                "downloaded": downloaded, "total": total,
                "percent": if total > 0 { downloaded as f64 / total as f64 } else { 0.0 },
            }));
        }
    }
    file.flush().map_err(|e| e.to_string())?;

    let digest: [u8; 32] = hasher.finalize().into();
    if digest != expected {
        let _ = std::fs::remove_file(part); // 校验失败（镜像损坏/投毒）→ 删除断点整体重下
        return Err("内容 hash 校验失败（文件损坏或来源不可信）".into());
    }
    Ok(())
}

pub(crate) fn file_sha256(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}
