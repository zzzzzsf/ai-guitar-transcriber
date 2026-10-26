#!/usr/bin/env bash
# 生成正式 minisign 更新签名密钥（方案 §11.2 R2 流程工具）：
#   1) 在仓库【外】的离线保存目录生成带密码密钥对（首发 pubkey 烧进二进制，发布后换钥 = 存量断更）
#   2) 自动更新 src-tauri/tauri.conf.json 的 plugins.updater.pubkey
#   3) 打印 CI Secrets 配置清单与私钥备份纪律
# 库内 keys/updater.key 仅为开发钥，纪律：永不签任何公开发布物。
#
# 用法：bash src-tauri/scripts/make-release-key.sh <仓库外的密钥保存目录> [密码]
#   密码缺省时由 tauri signer generate 交互输入（推荐——密码不进 shell 历史）
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${1:?用法: make-release-key.sh <仓库外的密钥保存目录> [密码]}"
mkdir -p "$DEST"

winpwd() { (cd "$1" && pwd -W 2>/dev/null || pwd); }
repo_root=$(winpwd ..)
dest_abs=$(winpwd "$DEST")
case "${dest_abs,,}" in
  "${repo_root,,}"|"${repo_root,,}"/*)
    echo "错误：密钥目录必须在仓库目录之外（离线保存，§11.2 R2）：$dest_abs" >&2
    exit 1 ;;
esac

KEY="$DEST/updater-release.key"
ARGS=(generate -w "$KEY" --force)
if [ -n "${2:-}" ]; then ARGS+=(--password "$2"); fi
npx --yes @tauri-apps/cli@2.12.4 signer generate "${ARGS[@]}"

PUB=$(tr -d '\n\r' < "$KEY.pub")
node -e "
const fs = require('fs');
const p = 'tauri.conf.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.plugins.updater.pubkey = process.argv[1];
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
console.log('tauri.conf.json > plugins.updater.pubkey 已更新');
" "$PUB"

echo
echo "================ 后续步骤（缺一不可，§11.2 R2） ================"
echo "1) 私钥 + 密码【离线双备份】（丢失 = 全体断更且无法补发）："
echo "     $KEY"
echo "2) GitHub 仓库 Settings → Secrets and variables → Actions 配置："
echo "     TAURI_SIGNING_PRIVATE_KEY          = 上面私钥文件的完整内容"
echo "     TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 密码"
echo "3) 本地构建注入改为新钥（开发钥从此不再用于任何发布物）："
echo "     export TAURI_SIGNING_PRIVATE_KEY=\"$KEY\""
echo "     export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码>"
echo "4) 发布前终审：bash scripts/release-gate.sh（检出 pubkey 仍是开发钥即 fail）"
