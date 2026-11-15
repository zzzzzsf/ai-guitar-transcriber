/**
 * `.agtp` 工程持久化 —— 目录即工程（v4.1 §2.2 + §1.4 工作分解 6/7）。
 *
 * 布局（fsAdapter 相对路径，根 = OPFS 或 node 工作区根）：
 *   projects/<slug>-<id8>.agtp/
 *   ├── project.json            # 元数据 + 谱引用（本引擎同时内联 alphaTex 便于单文件自检）
 *   ├── transcript/score.alphaTex
 *   ├── editOverlay.json        # 人工修正打标（§2.4，与转写结果分离存储）
 *   ├── source/audio-<sha256>.<ext> # 不可变音频版本（旧工程 original.<ext> 兼容）
 *   └── history/snapshots/<时间戳>-<label>.json   # AI 改谱历史，逐版可回滚
 *
 * 设计要点：
 * - project.json 是新保存工程的单一提交点，谱面/overlay 文件是派生副本；
 * - project.json 带 schemaVersion，加载走 migrate() 迁移链；
 * - 增量保存：saveProject 只写 project.json + score.alphaTex（音频、快照不动）；
 * - 谱面库（§2.2 library.json 可后置）：listProjects 现读各 project.json 头部即可。
 */
import { z } from 'zod';
import type { FrettedNote } from '../profiles/IInstrumentProfile';
import type { ChordLabel } from '../core/chordDetector';
import { EditEntrySchema } from './editOverlay';
import {
  bytesToText,
  FsNotFoundError,
  jsonToBytes,
  joinPath,
  sha256Hex,
  textToBytes,
  writeFileAtomic,
  type FsAdapter,
} from '../io/fsAdapter';

export const PROJECTS_DIR = 'projects';
export const SCHEMA_VERSION = 1;

// ---------- schema ----------

const NoteSchema = z.object({
  string: z.number().int(),
  fret: z.number().int(),
  onset: z.number(),
  duration: z.number(),
  pitch: z.number().int(),
  velocity: z.number().optional(),
  bend: z.array(z.object({ time: z.number(), cents: z.number() })).optional(),
  techniques: z.array(z.string()).optional(),
  // FrettedNote.tuplet 允许数字或标记字符串（历史导出形态）
  tuplet: z.union([z.number(), z.string()]).optional(),
  suspectedHarmonic: z.boolean().optional(),
});

const EMBEDDED_AUDIO_PATH = /^source\/audio-([a-f0-9]{64})\.[a-z0-9]+$/;

const AudioRefSchema = z.object({
  fileName: z.string().optional(),
  durationSec: z.number().optional(),
  sampleRate: z.number().optional(),
  sha256: z.string().optional(),
  storage: z.enum(['linked', 'embedded']),
  linkedPath: z.string().optional(),
  /** Project-relative immutable content path; absent in legacy projects. */
  embeddedPath: z.string().regex(EMBEDDED_AUDIO_PATH).optional(),
});

/**
 * 分轨引用（§2.2 stems/「默认外部引用 + 缓存路径」；§1.4 hash 缓存）：
 * 路径指向 tierRouter 的 stems-cache 目录；schema 显式声明防 zod strip
 * 在保存/加载往返时静默丢字段。
 */
const StemsRefSchema = z.object({
  hash: z.string(),
  tier: z.enum(['balanced', 'pro']),
  /** stem 名 → fs 相对路径（guitar/bass/...） */
  paths: z.record(z.string(), z.string()),
});

export const ProjectManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** New saves commit all editable content here; absent for legacy projects. */
  contentAuthority: z.literal('manifest').optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  instrument: z.string().default('guitar'),
  tuning: z.array(z.number().int()),
  capo: z.number().int().min(0).max(12),
  key: z.string().optional(),
  bpm: z.number().optional(),
  alphaTex: z.string(),
  notes: z.array(NoteSchema),
  chords: z.array(z.object({ bar: z.number().int(), name: z.string() })).optional(),
  audio: AudioRefSchema.optional(),
  stems: StemsRefSchema.optional(),
  editOverlay: z.array(EditEntrySchema).default([]),
});

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export type AudioRef = z.infer<typeof AudioRefSchema>;

export type ProjectSummary = {
  dir: string;
  id: string;
  name: string;
  updatedAt: string;
  instrument: string;
  capo: number;
  tuning: number[];
  key?: string;
  bpm?: number;
};

export type AiSnapshot = {
  at: number;
  label: string;
  alphaTex: string;
  /** 生成来源（改谱指令摘要等） */
  origin?: string;
};

const SnapshotSchema = z.object({
  at: z.number(),
  label: z.string().min(1),
  alphaTex: z.string(),
  origin: z.string().optional(),
});

// ---------- 工程目录命名 ----------

function slugify(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff.-]/g, '')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'untitled';
}

export function projectDirName(name: string, id: string): string {
  return `${slugify(name)}-${id.slice(0, 8)}.agtp`;
}

export function newProjectId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${rand}`;
}

function projectPath(dir: string): string {
  return joinPath(PROJECTS_DIR, dir);
}

// ---------- 创建 / 保存 / 加载 ----------

export type CreateProjectInput = {
  name: string;
  alphaTex: string;
  notes: FrettedNote[];
  tuning: number[];
  capo?: number;
  key?: string;
  bpm?: number;
  chords?: ChordLabel[];
  audio?: Omit<AudioRef, 'storage'> & { storage?: 'linked' | 'embedded' };
  id?: string;
  now?: number;
};

export function createProject(input: CreateProjectInput): ProjectManifest {
  const now = new Date(input.now ?? Date.now()).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? newProjectId(),
    name: input.name.trim() || '未命名工程',
    createdAt: now,
    updatedAt: now,
    instrument: 'guitar',
    tuning: input.tuning,
    capo: input.capo ?? 0,
    key: input.key,
    bpm: input.bpm,
    alphaTex: input.alphaTex,
    notes: input.notes,
    chords: input.chords,
    audio: input.audio ? { storage: 'linked', ...input.audio } : undefined,
    editOverlay: [],
  };
}

export type SaveProjectOptions = {
  /** 自包含模式：原音频字节拷入工程目录（链接模式只更新元数据） */
  audioBytes?: Uint8Array;
  audioFileName?: string;
};

/** Audio versions are staged first; project.json commits their reference with the score. */
export async function saveProject(
  fs: FsAdapter,
  project: ProjectManifest,
  opts: SaveProjectOptions = {},
): Promise<ProjectManifest> {
  const next: ProjectManifest = { ...project, contentAuthority: 'manifest', updatedAt: new Date().toISOString() };
  const root = projectPath(dirOfProject(next));

  if ((opts.audioBytes !== undefined) !== (opts.audioFileName !== undefined) ||
      (opts.audioFileName !== undefined && !opts.audioFileName.trim())) {
    throw new Error('嵌入音频必须同时提供音频字节和有效文件名');
  }
  if (opts.audioBytes !== undefined && opts.audioFileName !== undefined) {
    const audioBytes = opts.audioBytes.slice();
    const hash = await sha256Hex(audioBytes);
    const ext = (opts.audioFileName.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const embeddedPath = `source/audio-${hash}.${ext}`;
    const destination = joinPath(root, embeddedPath);
    if (await fs.exists(destination)) {
      if (await sha256Hex(await fs.readFile(destination)) !== hash) {
        throw new ProjectCorruptError(dirOfProject(next), `嵌入音频内容与哈希路径不符：${embeddedPath}`);
      }
    } else {
      await writeFileAtomic(fs, destination, audioBytes);
    }
    next.audio = {
      ...(next.audio ?? {}),
      fileName: opts.audioFileName,
      storage: 'embedded',
      sha256: hash,
      embeddedPath,
    };
  }

  await writeFileAtomic(fs, joinPath(root, 'project.json'), jsonToBytes(next));
  try {
    await writeFileAtomic(fs, joinPath(root, 'transcript', 'score.alphaTex'), textToBytes(next.alphaTex));
    if (next.editOverlay.length > 0) {
      await writeFileAtomic(fs, joinPath(root, 'editOverlay.json'), jsonToBytes(next.editOverlay));
    } else {
      await fs.remove(joinPath(root, 'editOverlay.json'));
    }
  } catch (error) {
    throw new Error(`工程已提交到 project.json，派生副本更新失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return next;
}

/** dir 名由 name+id 决定（“目录即工程”）；改名走 renameProject 同步目录 */
function dirOfProject(project: ProjectManifest): string {
  return projectDirName(project.name, project.id);
}

/** Publish a complete renamed copy before removing the original project. */
export async function renameProject(fs: FsAdapter, project: ProjectManifest, newName: string): Promise<ProjectManifest> {
  const oldDir = projectDirName(project.name, project.id);
  const { project: persisted } = await loadProject(fs, oldDir);
  const next: ProjectManifest = { ...persisted, contentAuthority: 'manifest',
    name: newName.trim() || persisted.name, updatedAt: new Date().toISOString() };
  const newDir = projectDirName(next.name, next.id);
  if (oldDir === newDir) {
    await writeFileAtomic(fs, joinPath(projectPath(oldDir), 'project.json'), jsonToBytes(next));
    return next;
  }
  if (await fs.exists(projectPath(newDir))) throw new Error(`目标工程目录已存在：${newDir}`);
  // The staging directory is not an .agtp entry and cannot appear as a
  // half-renamed project in listProjects. The source remains untouched.
  const staging = projectPath(`${newDir}.rename-${newProjectId()}.tmp`);
  try {
    await copyProjectFiles(fs, projectPath(oldDir), staging);
    await writeFileAtomic(fs, joinPath(staging, 'project.json'), jsonToBytes(next));
    await fs.move(staging, projectPath(newDir));
  } catch (error) {
    try { await fs.remove(staging); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `改名失败，原工程仍保留在 ${oldDir}；临时目录清理失败`); }
    throw error;
  }
  try { await fs.remove(projectPath(oldDir)); }
  catch (error) { throw new Error(`新工程已保存于 ${newDir}，旧工程目录 ${oldDir} 清理失败`, { cause: error }); }
  return next;
}

async function copyProjectFiles(fs: FsAdapter, from: string, to: string): Promise<void> {
  const entries = await fs.list(from);
  if (entries.length === 0) {
    // FsAdapter has no mkdir; a temporary file creates this empty directory
    // consistently on all three backends without expanding the interface.
    const placeholder = joinPath(to, `.rename-empty-${newProjectId()}`);
    await fs.writeFile(placeholder, new Uint8Array());
    await fs.remove(placeholder);
  }
  for (const entry of entries) {
    const source = joinPath(from, entry.path);
    const target = joinPath(to, entry.path);
    if (entry.dir) await copyProjectFiles(fs, source, target);
    else await fs.writeFile(target, await fs.readFile(source));
  }
}
export type LoadedProject = {
  project: ProjectManifest;
  dir: string;
  /** Effective score: committed manifest for new saves; standalone file for legacy projects. */
  alphaTexFile: string;
};

export class ProjectCorruptError extends Error {
  constructor(
    public readonly dir: string,
    public readonly reason: string,
  ) {
    super(`工程 ${dir} 损坏：${reason}`);
    this.name = 'ProjectCorruptError';
  }
}

/** 迁移链：未来 schemaVersion 升级时在此按版本逐级转换 */
function migrate(raw: unknown): unknown {
  const obj = raw as { schemaVersion?: number } | null;
  if (obj && typeof obj === 'object' && obj.schemaVersion === undefined) {
    return { ...obj, schemaVersion: SCHEMA_VERSION };
  }
  return raw;
}

export async function loadProject(fs: FsAdapter, dir: string): Promise<LoadedProject> {
  const root = projectPath(dir);
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await fs.readFile(joinPath(root, 'project.json'));
  } catch (e) {
    if (e instanceof FsNotFoundError) throw new ProjectCorruptError(dir, 'project.json 缺失');
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToText(manifestBytes));
  } catch (e) {
    throw new ProjectCorruptError(dir, `project.json 不是合法 JSON（${(e as Error).message}）`);
  }
  const schema = ProjectManifestSchema.safeParse(migrate(parsed));
  if (!schema.success) throw new ProjectCorruptError(dir, schema.error.issues[0]?.message ?? 'schema 不匹配');

  // Only legacy projects use standalone content. New saves have a single
  // commit point, so stale/partially updated mirrors must never be mixed in.
  let editOverlay = schema.data.editOverlay;
  if (schema.data.contentAuthority !== 'manifest') try {
    const overlayRaw = await fs.readFile(joinPath(root, 'editOverlay.json'));
    editOverlay = z.array(EditEntrySchema).parse(JSON.parse(bytesToText(overlayRaw)));
  } catch (e) {
    if (!(e instanceof FsNotFoundError)) {
      // overlay 损坏不阻塞工程加载（§2.4 冲突兜底思想），保留 manifest 内副本
      editOverlay = schema.data.editOverlay;
    }
  }

  let alphaTexFile = schema.data.alphaTex;
  if (schema.data.contentAuthority !== 'manifest') try {
    alphaTexFile = bytesToText(await fs.readFile(joinPath(root, 'transcript', 'score.alphaTex')));
  } catch {
    // 谱面文件缺失 → 退回 manifest 内联副本
  }

  return {
    project: { ...schema.data, editOverlay, alphaTex: alphaTexFile },
    dir,
    alphaTexFile,
  };
}

export async function deleteProject(fs: FsAdapter, dir: string): Promise<void> {
  await fs.remove(projectPath(dir));
}

/** 谱面库：扫描 projects/*.agtp 的 project.json 头部（§2.2 library.json 的替代实现） */
export async function listProjects(fs: FsAdapter): Promise<ProjectSummary[]> {
  let entries;
  try {
    entries = await fs.list(PROJECTS_DIR);
  } catch {
    return [];
  }
  const summaries: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.path.endsWith('.agtp')) continue;
    try {
      const raw = JSON.parse(bytesToText(await fs.readFile(joinPath(PROJECTS_DIR, entry.path, 'project.json'))));
      const m = ProjectManifestSchema.safeParse(migrate(raw));
      if (!m.success) continue;
      summaries.push({
        dir: entry.path,
        id: m.data.id,
        name: m.data.name,
        updatedAt: m.data.updatedAt,
        instrument: m.data.instrument,
        capo: m.data.capo,
        tuning: m.data.tuning,
        key: m.data.key,
        bpm: m.data.bpm,
      });
    } catch {
      // 单个工程损坏不拖垮列表
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- AI 改谱快照（§2.2 逐版回滚） ----------

function snapshotFileName(snapshot: { at: number; label: string }): string {
  const label = slugify(snapshot.label).slice(0, 24) || 'edit';
  return `${snapshot.at}-${label}.json`;
}

export async function writeSnapshot(fs: FsAdapter, dir: string, snapshot: AiSnapshot): Promise<string> {
  const parsed = SnapshotSchema.parse(snapshot);
  const name = snapshotFileName(parsed);
  await writeFileAtomic(fs, joinPath(projectPath(dir), 'history', 'snapshots', name), jsonToBytes(parsed));
  return name;
}

export type SnapshotMeta = { name: string; at: number; label: string };

/**
 * 快照列表（真·懒加载）：只解析文件名 `<at>-<label>.json` 取元数据，
 * 不读文件内容 —— 快照多时列目录零 IO 放大；正文按需 loadSnapshot。
 */
export async function listSnapshots(fs: FsAdapter, dir: string): Promise<SnapshotMeta[]> {
  let entries;
  try {
    entries = await fs.list(joinPath(projectPath(dir), 'history', 'snapshots'));
  } catch {
    return [];
  }
  const metas: SnapshotMeta[] = [];
  for (const entry of entries) {
    if (entry.dir || !entry.path.endsWith('.json')) continue;
    const m = /^(\d+)-(.+)\.json$/.exec(entry.path);
    if (!m) continue;
    metas.push({ name: entry.path, at: Number(m[1]), label: m[2] });
  }
  return metas.sort((a, b) => b.at - a.at);
}

export async function loadSnapshot(fs: FsAdapter, dir: string, name: string): Promise<AiSnapshot> {
  if (name.includes('..') || name.includes('/')) throw new Error('非法快照名');
  return SnapshotSchema.parse(JSON.parse(bytesToText(await fs.readFile(joinPath(projectPath(dir), 'history', 'snapshots', name)))));
}

/** 最近一次快照（懒加载“最新版”语义） */
export async function latestSnapshot(fs: FsAdapter, dir: string): Promise<AiSnapshot | null> {
  const metas = await listSnapshots(fs, dir);
  if (metas.length === 0) return null;
  return loadSnapshot(fs, dir, metas[0].name);
}

// ---------- 音频引用 ----------

/** 读自包含模式下的原音频字节 */
export async function readEmbeddedAudio(fs: FsAdapter, dir: string, audio: AudioRef): Promise<Uint8Array | null> {
  if (audio.storage !== 'embedded') return null;
  if (audio.embeddedPath !== undefined) {
    const match = EMBEDDED_AUDIO_PATH.exec(audio.embeddedPath);
    if (!match) throw new ProjectCorruptError(dir, '非法嵌入音频引用路径');
    const data = await fs.readFile(joinPath(projectPath(dir), audio.embeddedPath));
    const hash = await sha256Hex(data);
    if (hash !== match[1] || (audio.sha256 !== undefined && hash !== audio.sha256)) {
      throw new ProjectCorruptError(dir, '嵌入音频哈希校验失败');
    }
    return data;
  }
  // Legacy references have no explicit path. If a hash is present, identify
  // the matching original rather than choosing an unrelated extension.
  const files = await fs.list(joinPath(projectPath(dir), 'source'));
  const originals = files.filter((f) => !f.dir && /^original\.[a-z0-9]+$/i.test(f.path));
  for (const original of originals) {
    const data = await fs.readFile(joinPath(projectPath(dir), 'source', original.path));
    if (audio.sha256 === undefined || await sha256Hex(data) === audio.sha256) return data;
  }
  if (originals.length && audio.sha256 !== undefined) throw new ProjectCorruptError(dir, '旧版嵌入音频哈希校验失败');
  return null;
}
