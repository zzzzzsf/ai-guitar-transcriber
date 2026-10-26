/** 性能档位（§3 三级档位设计：用户自选高低配，零硬件探测复杂度） */
export type PerformanceTier = 'light' | 'balanced' | 'pro';

export const TIER_INFO: Record<
  PerformanceTier,
  { label: string; name: string; desc: string; mem: string; time: string; sidecar: boolean }
> = {
  light: {
    label: '⚡ 轻量极速档',
    name: 'Low-Spec / Solo Mode',
    desc: '老旧低配电脑 · 纯吉他独奏 / 指弹 / 干净弹唱。跳过重型分轨模型，Web Audio 带通滤波后直接前端转谱。',
    mem: '峰值内存 < 300 MB',
    time: '耗时 5 ~ 15 秒',
    sidecar: false,
  },
  balanced: {
    label: '⚖️ 均衡标准档',
    name: 'Balanced Mode',
    desc: '主流核显轻薄本 · 需要从混音歌曲中提取吉他。INT8 量化轻量分轨 + 3 秒切片流式推理防崩。',
    mem: '峰值内存 450 ~ 700 MB',
    time: '耗时 1 ~ 2.5 分钟',
    sidecar: true,
  },
  pro: {
    label: '🚀 高配精析档',
    name: 'High-Spec Pro Mode',
    desc: '独显台式机 / 游戏本 / M 系 Mac · 复杂乐队混音最高准确率。htdemucs_6s 六轨模型 + GPU 加速。',
    mem: '峰值内存 1.5 ~ 2.5 GB',
    time: '独显耗时 10 ~ 25 秒',
    sidecar: true,
  },
};
