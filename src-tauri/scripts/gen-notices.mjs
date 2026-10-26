#!/usr/bin/env node
// 格式化 cargo-about JSON 输出为 Rust 侧第三方许可清单（R7）。
// 重新生成流程（在 src-tauri/ 下，经 msvc 环境执行）：
//   1) cargo about generate --format json > /tmp/about.json
//   2) node scripts/gen-notices.mjs /tmp/about.json > THIRD-PARTY-NOTICES-RUST.txt
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv.slice(0, 2).concat(process.argv.slice(2));
if (!input || !output) {
  console.error('用法: node gen-notices.mjs <about.json 输入> <输出文件>');
  process.exit(1);
}
let raw = readFileSync(input, 'utf8');
// 剥离可能混入的前置日志行与后置 shell 输出
const start = raw.indexOf('{');
const end = raw.lastIndexOf('}');
raw = raw.slice(Math.max(0, start), end + 1);
const data = JSON.parse(raw);

const crates = data.crates ?? [];
const overview = data.overview ?? [];
const lines = [];
lines.push('AI 智能扒谱 · Windows 原生外壳（src-tauri）第三方 Rust 组件声明');
lines.push('================================================================');
lines.push(`生成方式：cargo about（Cargo.lock 全量闭包，含传递依赖 ${crates.length} 个 crate）`);
lines.push(`生成时间：${new Date().toISOString().slice(0, 10)}`);
lines.push('重新生成：见 src-tauri/scripts/gen-notices.mjs 文件头注释');
lines.push('前端 npm 依赖的声明见 app/THIRD-PARTY-NOTICES.txt（本文件只覆盖 Rust 壳工程）。');
lines.push('');
lines.push('================================================================');
lines.push('一、按许可证汇总（全文）');
lines.push('================================================================');
for (const lic of overview) {
  lines.push('');
  lines.push('----------------------------------------------------------------');
  lines.push(`${lic.id} — ${lic.name}（覆盖 ${lic.count} 个 crate）`);
  lines.push('----------------------------------------------------------------');
  lines.push(lic.text.trim());
}
lines.push('');
lines.push('================================================================');
lines.push('二、组件清单（按名称排序）');
lines.push('================================================================');
for (const c of [...crates].sort((a, b) =>
  (a.package?.name ?? '').localeCompare(b.package?.name ?? '')
)) {
  const lic = c.license || c.package?.license || '';
  lines.push(`- ${c.package?.name} ${c.package?.version} — ${lic}${c.package?.repository ? ` — ${c.package.repository}` : ''}`);
}
writeFileSync(output, lines.join('\n') + '\n', 'utf8');
console.log(`已写入 ${output}：${overview.length} 种许可证、${crates.length} 个 crate`);
