/**
 * ProfileRegistry — 乐器插件注册与查找（§2.1）。
 *
 * 首期只注册 Guitar；ES module 动态 import 懒加载（切到该乐器时按需加载，
 * 减小首屏体积）。远期才考虑第三方插件沙箱，首期所有 Profile 都是内置 TS。
 */
import { z } from 'zod';
import type {
  FingeringStyle,
  InstrumentConfig,
  InstrumentId,
  IInstrumentProfile,
} from './IInstrumentProfile';

export const instrumentConfigSchema = z.object({
  tuning: z.array(z.number().int().min(0).max(127)).optional(),
  capo: z.number().int().min(0).max(12).optional(),
  stringCount: z.number().int().min(4).max(12).optional(),
});

/** 校验用户配置（zod 运行时校验，非法输入抛出可读错误） */
export function validateConfig(config: unknown): InstrumentConfig {
  return instrumentConfigSchema.parse(config) as InstrumentConfig;
}

type ProfileLoader = () => Promise<IInstrumentProfile>;

/** 懒加载注册表：instrument id → 动态 import */
const loaders: Record<InstrumentId, ProfileLoader> = {
  guitar: async () => (await import('./GuitarProfile')).guitarProfile,
  // 二期扩展（接口已冻结，实现按 §4.3 接入）：
  bass: async () => {
    throw new Error('BassProfile 属于二期扩展，尚未接入');
  },
  vocal: async () => {
    throw new Error('VocalProfile 属于二期扩展，尚未接入');
  },
  piano: async () => {
    throw new Error('PianoProfile 属于三期扩展，尚未接入');
  },
  drums: async () => {
    throw new Error('DrumProfile 属于三期扩展，尚未接入');
  },
};

export const ProfileRegistry = {
  /** 按乐器 id 懒加载对应 Profile */
  async get(instrument: InstrumentId): Promise<IInstrumentProfile> {
    const loader = loaders[instrument];
    if (!loader) throw new Error(`未注册的乐器类型: ${instrument}`);
    return loader();
  },

  /** 转写入口：校验配置 → 懒加载 Profile → 执行 pipeline */
  async transcribe(
    instrument: InstrumentId,
    notes: Parameters<IInstrumentProfile['transcribe']>[0],
    config?: unknown,
    ctx?: { style?: FingeringStyle },
  ): Promise<ReturnType<IInstrumentProfile['transcribe']>> {
    const profile = await ProfileRegistry.get(instrument);
    return profile.transcribe(notes, {
      config: config !== undefined ? validateConfig(config) : undefined,
      ...ctx,
    });
  },
};
