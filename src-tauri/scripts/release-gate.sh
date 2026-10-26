#!/usr/bin/env bash
# 首发三件套终审（方案 §8.3「烧进二进制的三件套」/ §11.2 R1+R2）：
#   ① updater endpoints——占位符检出即 fail（首发后更换 = 存量安装更新通道永久断裂）
#   ② identifier——必须终审为 com.dsh.guitar（首发后改名 = 用户数据目录迁移事故）
#   ③ updater pubkey——非空，且不得仍是库内开发钥（R2 纪律：开发钥永不签公开发布物）
# CI（推 tag）与本机发布前都应跑：bash src-tauri/scripts/release-gate.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

CONF=src-tauri/tauri.conf.json
fail() { echo "::error::[release-gate] $1" >&2; exit 1; }

# ① endpoint 占位模式（含本仓库当前已知的占位 owner/repo）
if grep -nE 'dsh/ai-guitar-transcriber|\bOWNER\b|\bREPO\b|example\.com|your-repo|your-org|changeme|[<>]' "$CONF"; then
  fail "tauri.conf.json 仍含 updater endpoint 占位符——首发三件套烧进二进制，发布前必须替换为真实 owner/repo（§11.2 R1）"
fi

node - "$CONF" <<'EOF'
const fs = require('fs');
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fail = (m) => { console.error('::error::[release-gate] ' + m); process.exit(1); };
if (c.identifier !== 'com.dsh.guitar') {
  fail('identifier 须终审为 com.dsh.guitar（首发后不可改，§8.3 三件套）：当前 ' + c.identifier);
}
const eps = c.plugins?.updater?.endpoints;
if (!Array.isArray(eps) || eps.length === 0) fail('updater endpoints 不能为空');
for (const u of eps) {
  if (!/^https:\/\//.test(u)) fail('updater endpoint 须为 https：' + u);
  if (/dsh\/ai-guitar-transcriber|OWNER|REPO/i.test(u)) fail('endpoint 含占位符：' + u);
}
const pub = c.plugins?.updater?.pubkey;
if (typeof pub !== 'string' || pub.length < 50) fail('updater pubkey 缺失或过短');
EOF

# ③ 开发钥拦截：pubkey 若仍等于 keys/updater.key.pub 即 fail
if [ -f src-tauri/keys/updater.key.pub ]; then
  dev_pub=$(tr -d '\n\r \t' < src-tauri/keys/updater.key.pub)
  conf_pub=$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey" | tr -d '\n\r \t')
  if [ "$dev_pub" = "$conf_pub" ]; then
    fail "tauri.conf.json 仍是开发钥公钥——首发前必须换正式钥（bash src-tauri/scripts/make-release-key.sh，§11.2 R2）"
  fi
fi

echo '[release-gate] 首发三件套终审通过（endpoint 占位符未检出 / identifier=com.dsh.guitar / pubkey 非开发钥）'
