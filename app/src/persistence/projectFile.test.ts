import { describe, expect, it } from 'vitest';
import { MemoryFsAdapter, bytesToText } from '../io/fsAdapter';
import type { FrettedNote } from '../profiles/IInstrumentProfile';
import {
  createProject,
  deleteProject,
  latestSnapshot,
  listProjects,
  listSnapshots,
  loadProject,
  loadSnapshot,
  ProjectCorruptError,
  projectDirName,
  readEmbeddedAudio,
  renameProject,
  saveProject,
  writeSnapshot,
} from './projectFile';
import { makeFretEdit } from './editOverlay';

const NOTES: FrettedNote[] = [
  { onset: 0, duration: 0.5, pitch: 40, string: 6, fret: 0, velocity: 90 },
  { onset: 0.5, duration: 0.5, pitch: 45, string: 5, fret: 0, velocity: 88 },
];

const TEX = '\\tempo 120 :8 0.6 | :8 2.5';

function makeProject() {
  return createProject({
    name: '泪洒吉他',
    alphaTex: TEX,
    notes: NOTES,
    tuning: [40, 45, 50, 55, 59, 64],
    capo: 2,
    key: 'Em',
    bpm: 120,
    id: 'fixed0001',
  });
}

describe('目录即工程（§2.2）', () => {
  it('目录命名：slug 化 + id 前 8 位 + .agtp 后缀', () => {
    expect(projectDirName('泪洒吉他', 'abcd1234efgh')).toBe('泪洒吉他-abcd1234.agtp');
    expect(projectDirName('a/b:c?', 'abcd1234efgh')).toBe('a-b-c-abcd1234.agtp');
  });

  it('保存 → 目录结构 project.json + transcript/score.alphaTex', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    expect(await fs.exists(`projects/${dir}/project.json`)).toBe(true);
    expect(await fs.exists(`projects/${dir}/project.json.tmp`)).toBe(false);
    expect(bytesToText((await fs.readFile(`projects/${dir}/transcript/score.alphaTex`))!)).toBe(TEX);
  });

  it('保存/加载往返：manifest 字段一致', async () => {
    const fs = new MemoryFsAdapter();
    const saved = await saveProject(fs, makeProject());
    const { project } = await loadProject(fs, projectDirName('泪洒吉他', 'fixed0001'));
    expect(project.id).toBe('fixed0001');
    expect(project.name).toBe('泪洒吉他');
    expect(project.capo).toBe(2);
    expect(project.key).toBe('Em');
    expect(project.notes).toEqual(NOTES);
    expect(project.alphaTex).toBe(TEX);
    expect(project.updatedAt).toBe(saved.updatedAt);
  });

  it('editOverlay 存独立文件并在加载时合并回来', async () => {
    const fs = new MemoryFsAdapter();
    const base = makeProject();
    const withOverlay = {
      ...base,
      editOverlay: [makeFretEdit(NOTES[1], 4, 2, 5)],
    };
    await saveProject(fs, withOverlay);
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    expect(await fs.exists(`projects/${dir}/editOverlay.json`)).toBe(true);
    const { project } = await loadProject(fs, dir);
    expect(project.editOverlay).toHaveLength(1);
    expect(project.editOverlay[0].changes).toEqual({ string: 4, fret: 2 });
  });

  it('空 overlay 不留文件；manifest 缺 schemaVersion 走迁移', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    expect(await fs.exists(`projects/${dir}/editOverlay.json`)).toBe(false);

    // 手写一份无 schemaVersion 的旧数据
    const raw = JSON.parse(bytesToText(await fs.readFile(`projects/${dir}/project.json`)));
    delete raw.schemaVersion;
    await fs.writeFile(`projects/${dir}/project.json`, new TextEncoder().encode(JSON.stringify(raw)));
    const { project } = await loadProject(fs, dir);
    expect(project.schemaVersion).toBe(1);
  });

  it('project.json 缺失/损坏 → ProjectCorruptError', async () => {
    const fs = new MemoryFsAdapter();
    await expect(loadProject(fs, 'ghost.agtp')).rejects.toBeInstanceOf(ProjectCorruptError);
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    await saveProject(fs, makeProject());
    await fs.writeFile(`projects/${dir}/project.json`, new TextEncoder().encode('{oops'));
    await expect(loadProject(fs, dir)).rejects.toMatchObject({ name: 'ProjectCorruptError' });
  });

  it('自包含音频：拷贝 + sha256 + readEmbeddedAudio', async () => {
    const fs = new MemoryFsAdapter();
    const bytes = new TextEncoder().encode('RIFF-fake-wav-bytes');
    await saveProject(fs, makeProject(), { audioBytes: bytes, audioFileName: 'demo.wav' });
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    expect(await fs.exists(`projects/${dir}/source/original.wav`)).toBe(true);

    const { project } = await loadProject(fs, dir);
    expect(project.audio?.storage).toBe('embedded');
    expect(project.audio?.fileName).toBe('demo.wav');
    expect(project.audio?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const roundTrip = await readEmbeddedAudio(fs, dir, project.audio!);
    expect(new TextDecoder().decode(roundTrip!)).toBe('RIFF-fake-wav-bytes');
  });

  it('重命名 = 目录改名 + 元数据更新', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const oldDir = projectDirName('泪洒吉他', 'fixed0001');
    const renamed = await renameProject(fs, makeProject(), '新名字');
    const newDir = projectDirName('新名字', 'fixed0001');
    expect(newDir).not.toBe(oldDir);
    expect(await fs.exists(`projects/${oldDir}/project.json`)).toBe(false);
    await saveProject(fs, renamed);
    const { project } = await loadProject(fs, newDir);
    expect(project.name).toBe('新名字');
  });

  it('谱面库：listProjects 按 updatedAt 倒序，损坏工程跳过', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    await new Promise((r) => setTimeout(r, 3)); // updatedAt 是毫秒精度 ISO，隔开保证有序
    await saveProject(
      fs,
      createProject({ name: '第二个', alphaTex: ':8 0.6', notes: NOTES.slice(0, 1), tuning: [40, 45, 50, 55, 59, 64], id: 'fixed0002' }),
    );
    await fs.writeFile(
      `projects/${projectDirName('坏工程', 'dead00003')}/project.json`,
      new TextEncoder().encode('not json'),
    );
    const list = await listProjects(fs);
    expect(list.map((p) => p.id)).toEqual(['fixed0002', 'fixed0001']);
    expect(list[0].name).toBe('第二个');
    expect(list.every((p) => p.dir.endsWith('.agtp'))).toBe(true);
  });

  it('stems 引用（§2.2 外部引用模式）保存/加载往返不丢字段', async () => {
    const fs = new MemoryFsAdapter();
    const withStems = {
      ...makeProject(),
      stems: {
        hash: 'abc123',
        tier: 'balanced' as const,
        paths: { guitar: 'work/stems-cache/abc123-balanced/guitar.wav' },
      },
    };
    await saveProject(fs, withStems);
    const { project } = await loadProject(fs, projectDirName('泪洒吉他', 'fixed0001'));
    expect(project.stems).toEqual({
      hash: 'abc123',
      tier: 'balanced',
      paths: { guitar: 'work/stems-cache/abc123-balanced/guitar.wav' },
    });
  });

  it('删除工程目录', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    await deleteProject(fs, dir);
    expect(await fs.exists(`projects/${dir}`)).toBe(false);
  });
});

describe('AI 改谱快照（逐版回滚）', () => {
  it('写入 → 列表倒序 → 按需加载 → latest 懒加载最新版', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const dir = projectDirName('泪洒吉他', 'fixed0001');

    await writeSnapshot(fs, dir, { at: 1000, label: '降五品', alphaTex: ':8 0.6 v1' });
    await writeSnapshot(fs, dir, { at: 2000, label: '简化节奏', alphaTex: ':8 0.6 v2', origin: '把这段简化为分解和弦' });

    const metas = await listSnapshots(fs, dir);
    expect(metas.map((m) => m.at)).toEqual([2000, 1000]);
    expect(metas[0].label).toBe('简化节奏');

    const full = await loadSnapshot(fs, dir, metas[0].name);
    expect(full.alphaTex).toBe(':8 0.6 v2');
    expect(full.origin).toContain('分解和弦');

    const latest = await latestSnapshot(fs, dir);
    expect(latest?.alphaTex).toBe(':8 0.6 v2');
  });

  it('快照名路径穿越被拒', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const dir = projectDirName('泪洒吉他', 'fixed0001');
    await expect(loadSnapshot(fs, dir, '../../etc/passwd')).rejects.toThrow('非法快照名');
  });
});
