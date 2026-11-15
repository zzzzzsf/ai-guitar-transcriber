#!/usr/bin/env node
/** release-gate/check-versions 的无 shell 等价检查（本机 Git Bash 受限时使用）。 */
import { readFileSync } from 'node:fs';

const app = JSON.parse(readFileSync('app/package.json', 'utf8'));
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
const match = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
const versions = [app.version, conf.version, match?.[1]];
if (versions.some((v) => v !== app.version)) {
  throw new Error(`版本不同源：${versions.join(' / ')}`);
}

// Pushed release tags must match the package version. This prevents a tag like
// v0.1.2 from publishing assets whose paths and updater payload still point at
// v0.1.1 and overwriting an older published release.
if (process.env.GITHUB_EVENT_NAME === 'push') {
  const ref = process.env.GITHUB_REF ?? '';
  if (ref.startsWith('refs/tags/')) {
    const tag = ref.slice('refs/tags/'.length);
    if (tag !== `v${app.version}`) {
      throw new Error(`触发 tag ${tag} 与发布版本 v${app.version} 不一致`);
    }
  }
}

const endpoints = conf.plugins?.updater?.endpoints;
const pubkey = conf.plugins?.updater?.pubkey;
if (conf.identifier !== 'com.dsh.guitar') throw new Error('identifier 非终审值');
if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error('updater endpoint 为空');
if (typeof pubkey !== 'string' || pubkey.length < 50) throw new Error('updater pubkey 无效');
if (!endpoints.every((url) => /^https:\/\//.test(url))) {
  throw new Error('updater endpoint 必须是 HTTPS');
}
if (/OWNER|REPO|example\.com|your-repo|your-org|changeme|[<>]/i.test(JSON.stringify(conf))) {
  throw new Error('检测到发布占位符');
}
const devKey = readFileSync('src-tauri/keys/updater.key.pub', 'utf8').replace(/\s/g, '');
if (devKey === pubkey.replace(/\s/g, '')) throw new Error('仍是开发钥');

console.log(`release metadata OK · version ${app.version}`);
