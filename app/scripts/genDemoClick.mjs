/**
 * 生成演示点击轨 public/demo/click.wav（§3.5 网格 overlay 验证用）。
 * 拍点与 src/demoSong.ts 的 createDemoBeatTimes 严格一致：
 * 前 12s @80 BPM（每 4 拍强拍高音），后 16s @60 BPM。运行：node scripts/genDemoClick.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 22050;
const BPM_A = 80;
const BPM_B = 60;
const ARPEGGIO_SEC = 4 * 4 * (60 / BPM_A); // 12
const DURATION = ARPEGGIO_SEC + 4 * 4 * (60 / BPM_B); // 28

const beats = [];
for (let t = 0; t < ARPEGGIO_SEC - 1e-9; t += 60 / BPM_A) beats.push(Number(t.toFixed(6)));
for (let t = ARPEGGIO_SEC; t < DURATION - 1e-9; t += 60 / BPM_B) beats.push(Number(t.toFixed(6)));

const total = Math.floor(DURATION * SR);
const data = new Float32Array(total);
const clickLen = Math.floor(0.03 * SR);
beats.forEach((t, i) => {
  const start = Math.floor(t * SR);
  const accent = i % 4 === 0;
  const freq = accent ? 1600 : 1000;
  const amp = accent ? 0.85 : 0.5;
  for (let k = 0; k < clickLen && start + k < total; k++) {
    data[start + k] +=
      amp * Math.sin((2 * Math.PI * freq * k) / SR) * Math.exp(-k / (clickLen / 4));
  }
});

// 16-bit PCM WAV
const bytesPerSample = 2;
const dataSize = total * bytesPerSample;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * bytesPerSample, 28);
buf.writeUInt16LE(bytesPerSample, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < total; i++) {
  const v = Math.max(-1, Math.min(1, data[i]));
  buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}

const outDir = join(root, 'public', 'demo');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'click.wav'), buf);
console.log(`written ${join(outDir, 'click.wav')} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${beats.length} beats)`);
