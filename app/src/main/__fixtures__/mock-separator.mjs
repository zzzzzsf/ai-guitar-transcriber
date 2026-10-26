/**
 * separator-cli 的 mock 实现（仅测试用）。
 * 契约见 separatorRunner.ts 头注：--input/--output/--model/--segment + stdout `progress=N`。
 *
 * 额外测试开关：
 *   --fail exit     退出码 1（模拟崩溃）
 *   --fail spawn    立即向 stderr 写错误并退出码 127（模拟二进制缺失）
 *   --hang          只输出一条进度然后挂住（模拟超时/取消；SIGTERM 后退出码 143）
 *   --steps N       进度步数（默认 5，每步 12ms）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const outDir = arg('output') ?? '.';
const failMode = arg('fail');
const hang = argv.includes('--hang');
const steps = Number(arg('steps') ?? 5);

if (failMode === 'spawn') {
  process.stderr.write("Error: cannot open binary: No such file or directory\n");
  exit(127);
}

let step = 0;
const timer = setInterval(() => {
  step += 1;
  process.stdout.write(`progress=${Math.round((step / steps) * 100)}\n`);
  if (step >= steps) {
    clearInterval(timer);
    if (failMode === 'exit') {
      process.stderr.write('separation failed: model not found\n');
      exit(1);
    }
    try {
      mkdirSync(outDir, { recursive: true });
      for (const stem of ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other']) {
        writeFileSync(`${outDir}/${stem}.wav`, `RIFF-mock-${stem}`);
      }
      process.stdout.write('progress=100\n');
      exit(0);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      exit(1);
    }
  }
}, 12);

if (hang) {
  clearInterval(timer);
  process.stdout.write('progress=10\n');
  // 空定时器占住事件循环（signal 监听不保持进程存活），等待被 kill
  setInterval(() => {}, 1 << 30);
}

process.on('SIGTERM', () => exit(143));
