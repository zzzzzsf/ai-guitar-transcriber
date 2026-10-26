#!/usr/bin/env bash
# 版本号三处同源校验（方案 §8.5）：
#   app/package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
# 用法：bash src-tauri/scripts/check-versions.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

pkg=$(node -p "require('./app/package.json').version")
conf=$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).version")
cargo_ver=$(grep -m1 '^version' src-tauri/Cargo.toml | sed 's/version *= *"\(.*\)"/\1/')

echo "app/package.json      = $pkg"
echo "tauri.conf.json       = $conf"
echo "src-tauri/Cargo.toml  = $cargo_ver"

if [ "$pkg" = "$conf" ] && [ "$pkg" = "$cargo_ver" ]; then
  echo "OK：三处版本一致"
else
  echo "错误：三处版本不一致（发 tag 前必须同步）" >&2
  exit 1
fi
