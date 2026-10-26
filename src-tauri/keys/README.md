# keys/ — 更新签名密钥（minisign）

本目录存放 `tauri signer generate` 生成的**更新签名**密钥（与代码签名
Authenticode 是两回事——方案 §8.3/§8.4）。

## 当前状态（§11.2 R2）

- `updater.key` / `updater.key.pub` — **开发钥**（无密码，2026-10 本机生成），
  仅用于本地开发构建自测。**纪律：开发钥永不签任何公开发布物。**
- 正式钥尚未生成——首发前必须执行 R2（pubkey 烧进首发二进制，发布后换钥 =
  存量更新签名全部不被信任，当前是零成本替换窗口）。

## 生成正式钥（R2 流程）

```bash
# <仓库外的密钥保存目录>：如 D:\keys\ai-guitar-transcriber\（离线保存，脚本会拒绝仓库内路径）
bash src-tauri/scripts/make-release-key.sh <仓库外的目录> [密码]
```

脚本会：① 生成带密码密钥对到仓库外；② 自动更新 `tauri.conf.json` 的
`plugins.updater.pubkey`；③ 打印 GitHub Secrets（`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）配置清单与私钥离线双备份提醒。

## CI 拦截

推 tag 时 CI 跑 `scripts/release-gate.sh`：`tauri.conf.json` 的 pubkey 若仍等于
`updater.key.pub`（开发钥）或 endpoint 含占位符，**构建直接 fail**（§8.3 首发
三件套：endpoint / pubkey / identifier 烧进二进制，首发后视为不可改）。

## 本地构建签名注入

```bash
# 开发钥（本地自测）
export TAURI_SIGNING_PRIVATE_KEY="E:/dsh_flies/Guitar/src-tauri/keys/updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# 正式钥（R2 之后，路径即 make-release-key.sh 的仓库外目录）
export TAURI_SIGNING_PRIVATE_KEY="<离线目录>/updater-release.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码>
```

**私钥丢失 = 换钥 = 强制全体手动重装一次**——离线双备份是硬要求。
