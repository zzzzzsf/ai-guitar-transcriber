/**
 * 音频前处理 — 冻结自《吉他扒谱-细化方案 v4.1》§3.2（含 2026-10 修订条与实测修正）。
 *
 * 流水线：解码 → stereo→mono（反相检测兜底）→ 重采样 22050Hz mono
 *        → 轻量档带通 70Hz~8kHz（仅轻量档）→ 峰值归一化（可选）→ Float32Array
 *
 * §3.2 修订条"不自做预重采样、原采样率直喂 basic-pitch"经实测（Step 3 接入时）
 * 不成立：@spotify/basic-pitch 1.0.1 的 evaluateModel 对非 22050Hz 的 AudioBuffer
 * 直接 throw、Float32Array 按 22050 假定（esm/inference.js AUDIO_SAMPLE_RATE 校验），
 * 并无内部重采样。按该条自带的兜底方式，重采样保留在本模块（OfflineAudioContext，
 * Web Audio 标准路径），产出 22050Hz mono 供 basic-pitch 直接消费。
 * 纯 Web Audio API，零外部依赖；仅浏览器环境可用。
 */

export type PreprocessOptions = {
  /** 轻量档带通滤波（标准/高配档交给分轨引擎，不开） */
  bandpass?: boolean;
  /** 峰值归一化到 -3dB（防动态范围太小） */
  normalize?: boolean;
};

export type PreprocessResult = {
  samples: Float32Array;
  sampleRate: number;
};

const TARGET_SAMPLE_RATE = 22050;
/** 吉他最低 E2=82Hz、Drop D D2=73Hz，70Hz 安全保留；滤底鼓/嗡嗡声/DC */
const HIGHPASS_HZ = 70;
/** 吉他泛音到第 6 倍音约 5kHz，8kHz 留余量；滤镲片高频串音 */
const LOWPASS_HZ = 8000;

function requireBrowser(): void {
  if (typeof window === 'undefined' || typeof OfflineAudioContext === 'undefined') {
    throw new Error('audioPreprocessor 需要浏览器环境（Web Audio API）');
  }
}

/** mp3/m4a/flac/wav → AudioBuffer */
export async function decodeToAudioBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
  requireBrowser();
  // decodeAudioData 挂在 BaseAudioContext 上；用短 OfflineAudioContext 承载
  const ctx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  return ctx.decodeAudioData(data);
}

/** stereo → mono；检测到相位反相时用 mid-side (L-R)/2 兜底 */
export function mixToMono(buffer: AudioBuffer): Float32Array<ArrayBuffer> {
  const length = buffer.length;
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  // 取前 10 秒估计左右声道相关性
  const n = Math.min(length, buffer.sampleRate * 10);
  let corr = 0;
  for (let i = 0; i < n; i++) corr += l[i] * r[i];
  const inverted = corr < 0;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    mono[i] = inverted ? (l[i] - r[i]) / 2 : (l[i] + r[i]) / 2;
  }
  return mono;
}

/** 峰值归一化到 -3dB（0.708） */
export function normalizePeak(samples: Float32Array, targetDb = -3): void {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak <= 1e-9) return;
  const target = Math.pow(10, targetDb / 20);
  const gain = target / peak;
  if (gain < 0.999 || gain > 1.001) {
    for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  }
}

/**
 * 完整前处理：输入任意格式音频文件字节 → 22050Hz mono Float32Array。
 * 3 分钟歌曲重采样 < 1 秒，产物约 15.9MB，无内存压力。
 */
export async function preprocessAudio(
  data: ArrayBuffer,
  opts: PreprocessOptions = {},
): Promise<PreprocessResult> {
  requireBrowser();
  const buffer = await decodeToAudioBuffer(data);
  const mono = mixToMono(buffer);

  // 重采样（+ 可选带通）离线渲染到目标采样率
  const ratio = TARGET_SAMPLE_RATE / buffer.sampleRate;
  const outLength = Math.max(1, Math.ceil(mono.length * ratio));
  const ctx = new OfflineAudioContext(1, outLength, TARGET_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  const tmp = ctx.createBuffer(1, mono.length, buffer.sampleRate);
  tmp.copyToChannel(mono, 0);
  src.buffer = tmp;

  let node: AudioNode = src;
  if (opts.bandpass) {
    // 串联两个 BiquadFilter：高通 + 低通
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = HIGHPASS_HZ;
    hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = LOWPASS_HZ;
    lp.Q.value = 0.707;
    node.connect(hp);
    hp.connect(lp);
    node = lp;
  }
  node.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();

  const samples = rendered.getChannelData(0).slice();
  if (opts.normalize !== false) normalizePeak(samples);
  return { samples, sampleRate: TARGET_SAMPLE_RATE };
}
