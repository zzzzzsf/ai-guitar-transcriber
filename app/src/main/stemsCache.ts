/**
 * stems 分轨缓存（v4.1 §1.4）：
 * 按源音频内容 hash + 档位 缓存于工作区 stems-cache/，
 * 切换档位重跑不重复分轨；hash 未变且档位相同直接复用。
 */
import { joinPath, sha256Hex, type FsAdapter } from '../io/fsAdapter';
import type { StemName } from './separatorRunner';

export const STEMS_ALL: StemName[] = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other'];

export function stemsCacheDir(workRoot: string, hash: string, tier: 'balanced' | 'pro'): string {
  return joinPath(workRoot, 'stems-cache', `${hash}-${tier}`);
}

export async function cacheKeyOf(getBytes: () => Promise<Uint8Array>): Promise<string> {
  return sha256Hex(await getBytes());
}

/** 缓存命中 → 各 stem 的 fs 相对路径；任一 stem 文件缺失视为未命中 */
export async function findStems(
  fs: FsAdapter,
  workRoot: string,
  hash: string,
  tier: 'balanced' | 'pro',
): Promise<Partial<Record<StemName, string>> | null> {
  const dir = stemsCacheDir(workRoot, hash, tier);
  let entries;
  try {
    entries = await fs.list(dir);
  } catch {
    return null;
  }
  const stems: Partial<Record<StemName, string>> = {};
  for (const entry of entries) {
    const stem = entry.path.replace(/\.wav$/i, '') as StemName;
    if (STEMS_ALL.includes(stem)) stems[stem] = joinPath(dir, entry.path);
  }
  return Object.keys(stems).length > 0 ? stems : null;
}

export async function saveStems(
  fs: FsAdapter,
  workRoot: string,
  hash: string,
  tier: 'balanced' | 'pro',
  stems: Record<string, Uint8Array>,
): Promise<Partial<Record<StemName, string>>> {
  const dir = stemsCacheDir(workRoot, hash, tier);
  const saved: Partial<Record<StemName, string>> = {};
  for (const [stem, bytes] of Object.entries(stems)) {
    await fs.writeFile(joinPath(dir, `${stem}.wav`), bytes);
    saved[stem as StemName] = joinPath(dir, `${stem}.wav`);
  }
  return saved;
}
