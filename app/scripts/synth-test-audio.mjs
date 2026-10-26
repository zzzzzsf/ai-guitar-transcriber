/**
 * 合成吉他测试音频（Karplus-Strong 拨弦模型）→ public/demo/pluck-120bpm.wav
 * 120 BPM 四分音符序列（Em 琶音下行），音符 onset 已知，用于核对转谱准确度。
 * 运行：node scripts/synth-test-audio.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
// 音符序列：[midi, onsetBeat]
const NOTES = [
  [40, 0], // E2
  [55, 1], // G3
  [59, 2], // B3
  [64, 3], // E4
  [62, 4], // D4
  [59, 5], // B3
  [55, 6], // G3
  [40, 7], // E2
];
const TOTAL = 8 * BEAT + 1;

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const out = new Float32Array(Math.ceil(TOTAL * SR));

for (const [midi, beat] of NOTES) {
  const f = midiToHz(midi);
  const n = Math.round(SR / f);
  // 激励缓冲：噪声（拨弦）
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.random() * 2 - 1;
  const start = Math.round(beat * BEAT * SR);
  const dur = Math.round(SR * 0.9); // 弦衰减约 0.9s
  // 每样本 0.9995：一个周期（E2 约 535 样本）衰减到 ~77%，0.9s 内自然消音；
  // KS 平均本身也在耗能，额外系数过大会把音符变成 ~30ms 咔哒声（basic-pitch 检不出）
  const decay = 0.9995;
  for (let i = 0; i < dur; i++) {
    const idx = start + i;
    if (idx >= out.length) break;
    const v = 0.5 * decay * (buf[i % n] + buf[(i + 1) % n]);
    buf[i % n] = v;
    out[idx] += v;
  }
}

// 峰值归一化到 -3dB
let peak = 0;
for (const v of out) peak = Math.max(peak, Math.abs(v));
const gain = Math.pow(10, -3 / 20) / peak;
const pcm = new Int16Array(out.length);
for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * gain * 32768)));

// WAV 头（PCM 16bit mono）
const dataSize = pcm.length * 2;
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataSize, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(dataSize, 40);

mkdirSync(new URL('../public/demo/', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/demo/pluck-120bpm.wav', import.meta.url), Buffer.concat([header, Buffer.from(pcm.buffer)]));
console.log(`written public/demo/pluck-120bpm.wav: ${((36 + dataSize) / 1024).toFixed(0)}KB, ${TOTAL.toFixed(1)}s, notes: ${NOTES.length}`);

// ---- 附加产物：长曲（§3.2 分段验证）----
// 20 个乐句块（每块 = 4s 乐句 + 1s 静音）= 100s，静音间隔供分段切点选取
function synthLong() {
  const total = 20 * 5 + 1;
  const outL = new Float32Array(Math.ceil(total * SR));
  for (let loop = 0; loop < 20; loop++) {
    const t0 = loop * 5;
    for (const [midi, beat] of NOTES) {
      const f = midiToHz(midi);
      const n = Math.round(SR / f);
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) buf[i] = Math.random() * 2 - 1;
      const start = Math.round((t0 + beat * BEAT) * SR);
      const decay = 0.9995;
      for (let i = 0; i < Math.round(SR * 0.9); i++) {
        const idx = start + i;
        if (idx >= outL.length) break;
        const v = 0.5 * decay * (buf[i % n] + buf[(i + 1) % n]);
        buf[i % n] = v;
        outL[idx] += v;
      }
    }
  }
  let pk = 0;
  for (const v of outL) pk = Math.max(pk, Math.abs(v));
  const g = Math.pow(10, -3 / 20) / pk;
  const pcmL = new Int16Array(outL.length);
  for (let i = 0; i < outL.length; i++)
    pcmL[i] = Math.max(-32768, Math.min(32767, Math.round(outL[i] * g * 32768)));
  const dataSizeL = pcmL.length * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataSizeL, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataSizeL, 40);
  writeFileSync(new URL('../public/demo/pluck-long-100s.wav', import.meta.url), Buffer.concat([h, Buffer.from(pcmL.buffer)]));
  console.log(`written public/demo/pluck-long-100s.wav: ${((36 + dataSizeL) / 1024 / 1024).toFixed(1)}MB, ${total}s`);
}
synthLong();
