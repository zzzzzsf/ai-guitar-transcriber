/**
 * Viterbi 弦品寻路代价函数权重 — 冻结自《吉他扒谱-细化方案 v4.1》§4.1。
 *
 * TotalCost = wStretch·C_stretch + wMove·C_move + wStringChange·C_string_change
 *           + wFret·C_fret + wOpen·C_open + wPosPrior·C_pos_prior
 *
 * w_samestring（硬约束）不作为可调权重：同弦互斥在候选生成阶段直接剪枝。
 * 权重需配合 §1.2 测试集调参迭代；集中在本文件方便 CI 回归对比。
 */
import type { FingeringStyle } from './IInstrumentProfile';

export type CostWeights = {
  /** 跨度超 reach 后指数增长项的权重 */
  wStretch: number;
  /** 把位跳跃（含时间衰减） */
  wMove: number;
  /** 换弦（独立于把位的维度） */
  wStringChange: number;
  /** 品位绝对值（偏好低品），C = fret / 24 */
  wFret: number;
  /** 空弦偏好（负值 = 奖励），C = fret === 0 ? 1 : 0 */
  wOpen: number;
  /** V 形低把位先验，C = |fret - posPriorCenter| */
  wPosPrior: number;
  /** 把位惩罚时间衰减陡峭度 */
  timeFactorK: number;
  /** 休止间隔 > 此值（秒）时免费重定位 */
  moveFreeGap: number;
  /** 单手跨度舒适阈值（品） */
  reach: number;
  /** V 形先验中心（品） */
  posPriorCenter: number;
};

/** 均衡档（默认） */
export const BALANCED_WEIGHTS: CostWeights = {
  wStretch: 1.0,
  wMove: 0.5,
  wStringChange: 0.3,
  wFret: 0.2,
  wOpen: -0.3,
  wPosPrior: 0.4,
  timeFactorK: 0.5,
  moveFreeGap: 0.4,
  reach: 4,
  posPriorCenter: 5,
};

/** 省力档（新手）：大鼓励空弦、放宽跨度、强低把位偏好 */
export const EASY_WEIGHTS: CostWeights = {
  ...BALANCED_WEIGHTS,
  wStretch: 1.5,
  wStringChange: 0.4,
  wFret: 0.3,
  wOpen: -0.8,
  wPosPrior: 0.6,
  reach: 5,
};

/** 忠于原音档：不偏置空弦、收紧跨度、弱化先验 */
export const FAITHFUL_WEIGHTS: CostWeights = {
  ...BALANCED_WEIGHTS,
  wStretch: 0.8,
  wStringChange: 0.2,
  wFret: 0.1,
  wOpen: 0,
  wPosPrior: 0.2,
  reach: 3,
};

export const STYLE_PRESETS: Record<FingeringStyle, CostWeights> = {
  easy: EASY_WEIGHTS,
  balanced: BALANCED_WEIGHTS,
  faithful: FAITHFUL_WEIGHTS,
};

export function resolveWeights(
  style: FingeringStyle = 'balanced',
  override?: Partial<CostWeights>,
): CostWeights {
  return { ...STYLE_PRESETS[style], ...override };
}
