import { describe, expect, it } from 'vitest';
import { MemoryFsAdapter, bytesToText, jsonToBytes, sha256Hex, textToBytes } from '../io/fsAdapter';
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

    const { project } = await loadProject(fs, dir);
    expect(project.audio?.storage).toBe('embedded');
    expect(project.audio?.fileName).toBe('demo.wav');
    expect(project.audio?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(project.audio?.embeddedPath).toBe(`source/audio-${project.audio?.sha256}.wav`);
    expect(await fs.exists(`projects/${dir}/${project.audio!.embeddedPath}`)).toBe(true);

    const roundTrip = await readEmbeddedAudio(fs, dir, project.audio!);
    expect(new TextDecoder().decode(roundTrip!)).toBe('RIFF-fake-wav-bytes');
  });

  it.each([
    ['new', 'write'], ['new', 'commit'], ['legacy', 'write'], ['legacy', 'commit'],
  ])('更新 %s 音频后 manifest %s 失败：旧引用、notes、谱面与音频字节保持同一版本', async (format, phase) => {
    class FaultFs extends MemoryFsAdapter {
      fail = false;
      override async writeFile(path: string, data: Uint8Array) {
        if (this.fail && phase === 'write' && path.endsWith('/project.json.tmp')) throw new Error('manifest failed');
        return super.writeFile(path, data);
      }
      override async move(from: string, to: string) {
        if (this.fail && phase === 'commit' && to.endsWith('/project.json')) throw new Error('manifest failed');
        return super.move(from, to);
      }
    }
    const fs = new FaultFs();
    const oldBytes = textToBytes('old original recording');
    const newBytes = textToBytes('new replacement recording');
    let previous = makeProject();
    const dir = projectDirName(previous.name, previous.id);
    if (format === 'legacy') {
      previous = { ...previous, audio: { storage: 'embedded', fileName: 'old.wav', sha256: await sha256Hex(oldBytes) } };
      await fs.writeFile(`projects/${dir}/source/original.wav`, oldBytes);
      await fs.writeFile(`projects/${dir}/project.json`, jsonToBytes(previous));
    } else {
      previous = await saveProject(fs, previous, { audioBytes: oldBytes, audioFileName: 'old.wav' });
    }
    const oldPath = `projects/${dir}/${previous.audio!.embeddedPath ?? 'source/original.wav'}`;
    const oldManifest = (await fs.readFile(`projects/${dir}/project.json`)).slice();
    const changed = { ...previous, notes: [NOTES[1]], alphaTex: 'new score' };
    fs.fail = true;
    await expect(saveProject(fs, changed, { audioBytes: newBytes, audioFileName: 'new.wav' })).rejects.toThrow('manifest failed');
    const loaded = await loadProject(fs, dir);
    expect(await fs.readFile(`projects/${dir}/project.json`)).toEqual(oldManifest);
    expect(loaded.project.notes).toEqual(previous.notes);
    expect(loaded.project.alphaTex).toBe(previous.alphaTex);
    expect(loaded.project.audio).toEqual(previous.audio);
    expect(await readEmbeddedAudio(fs, dir, loaded.project.audio!)).toEqual(oldBytes);
    expect(await fs.readFile(oldPath)).toEqual(oldBytes);
    fs.fail = false;
    const committed = await saveProject(fs, changed, { audioBytes: newBytes, audioFileName: 'new.wav' });
    const next = (await loadProject(fs, dir)).project;
    expect(next.audio).toEqual(committed.audio);
    expect(next.audio!.embeddedPath).not.toBe(previous.audio!.embeddedPath);
    expect(await readEmbeddedAudio(fs, dir, next.audio!)).toEqual(newBytes);
    expect(await fs.readFile(oldPath)).toEqual(oldBytes);
  });

  it('旧 original.ext 引用兼容，多个扩展名按旧哈希取正确原音频', async () => {
    const fs = new MemoryFsAdapter();
    const previous = makeProject();
    const dir = projectDirName(previous.name, previous.id);
    const bytes = textToBytes('legacy wav recording');
    await fs.writeFile(`projects/${dir}/source/original.mp3`, textToBytes('unrelated recording'));
    await fs.writeFile(`projects/${dir}/source/original.wav`, bytes);
    previous.audio = { storage: 'embedded', sha256: await sha256Hex(bytes) };
    await fs.writeFile(`projects/${dir}/project.json`, jsonToBytes(previous));
    const loaded = await loadProject(fs, dir);
    expect(await readEmbeddedAudio(fs, dir, loaded.project.audio!)).toEqual(bytes);
    expect(await readEmbeddedAudio(fs, dir, { storage: 'embedded' })).not.toBeNull();
  });

  it('同内容重复保存复用不可变音频，不覆盖已存在的哈希路径', async () => {
    class AudioWriteFs extends MemoryFsAdapter {
      refuseAudioWrite = false;
      override async writeFile(path: string, data: Uint8Array) {
        if (this.refuseAudioWrite && path.includes('/source/')) throw new Error('audio must not be rewritten');
        return super.writeFile(path, data);
      }
    }
    const fs = new AudioWriteFs();
    const bytes = textToBytes('same recording');
    const project = await saveProject(fs, makeProject(), { audioBytes: bytes, audioFileName: 'demo.wav' });
    fs.refuseAudioWrite = true;
    const next = await saveProject(fs, project, { audioBytes: bytes, audioFileName: 'demo.wav' });
    expect(next.audio!.embeddedPath).toBe(project.audio!.embeddedPath);
    const dir = projectDirName(next.name, next.id);
    expect(await readEmbeddedAudio(fs, dir, next.audio!)).toEqual(bytes);
  });

  it('显式音频引用丢失或校验失败时不悄悄改读旧 original.wav', async () => {
    const fs = new MemoryFsAdapter();
    const bytes = textToBytes('committed recording');
    const project = await saveProject(fs, makeProject(), { audioBytes: bytes, audioFileName: 'demo.wav' });
    const dir = projectDirName(project.name, project.id);
    const path = `projects/${dir}/${project.audio!.embeddedPath}`;
    await fs.writeFile(`projects/${dir}/source/original.wav`, textToBytes('wrong legacy recording'));
    await fs.writeFile(path, textToBytes('corrupt bytes'));
    await expect(readEmbeddedAudio(fs, dir, project.audio!)).rejects.toBeInstanceOf(ProjectCorruptError);
    await expect(saveProject(fs, project, { audioBytes: bytes, audioFileName: 'demo.wav' })).rejects.toBeInstanceOf(ProjectCorruptError);
    expect(bytesToText(await fs.readFile(path))).toBe('corrupt bytes');
    await fs.remove(path);
    await expect(readEmbeddedAudio(fs, dir, project.audio!)).rejects.toThrow('文件不存在');
  });

  it('重命名 = 目录改名 + 元数据更新', async () => {
    const fs = new MemoryFsAdapter();
    await saveProject(fs, makeProject());
    const oldDir = projectDirName('泪洒吉他', 'fixed0001');
    const renamed = await renameProject(fs, makeProject(), '新名字');
    const newDir = projectDirName('新名字', 'fixed0001');
    expect(newDir).not.toBe(oldDir);
    expect(await fs.exists(`projects/${oldDir}/project.json`)).toBe(false);
    const { project } = await loadProject(fs, newDir);
    expect(project.name).toBe('新名字');
    expect(project.id).toBe(renamed.id);
    expect((await listProjects(fs)).map((entry) => entry.name)).toEqual(['新名字']);
  });

  it.each(['score.alphaTex.tmp', 'editOverlay.json.tmp'])('保存副本 %s 失败后加载仍是同一提交的 notes/score/overlay', async (failure) => {
    class FaultFs extends MemoryFsAdapter {
      fail = false;
      override async writeFile(path: string, data: Uint8Array) {
        if (this.fail && path.endsWith(failure)) throw new Error('injected mirror failure');
        return super.writeFile(path, data);
      }
    }
    const fs = new FaultFs();
    const previous = await saveProject(fs, makeProject());
    const next = { ...previous, alphaTex: '\\tempo 90 :8 5.1',
      notes: [{ ...NOTES[0], pitch: 69, string: 1, fret: 5 }],
      editOverlay: [makeFretEdit(NOTES[0], 1, 5, 10)] };
    fs.fail = true;
    await expect(saveProject(fs, next)).rejects.toThrow('injected mirror failure');
    const loaded = await loadProject(fs, projectDirName(previous.name, previous.id));
    expect(loaded.project.alphaTex).toBe(next.alphaTex);
    expect(loaded.alphaTexFile).toBe(next.alphaTex);
    expect(loaded.project.notes).toEqual(next.notes);
    expect(loaded.project.editOverlay).toEqual(next.editOverlay);
  });

  it('manifest 提交失败保留上一完整版本；重试成功后一次切换版本', async () => {
    class FaultFs extends MemoryFsAdapter {
      fail = false;
      override async move(from: string, to: string) {
        if (this.fail && to.endsWith('/project.json')) throw new Error('commit failed');
        return super.move(from, to);
      }
    }
    const fs = new FaultFs();
    const previous = await saveProject(fs, makeProject());
    const next = { ...previous, alphaTex: '\\tempo 90 :4 5.1', notes: [{ ...NOTES[0], fret: 5 }] };
    const dir = projectDirName(previous.name, previous.id);
    fs.fail = true;
    await expect(saveProject(fs, next)).rejects.toThrow('commit failed');
    expect((await loadProject(fs, dir)).project).toEqual(previous);
    fs.fail = false;
    await saveProject(fs, next);
    expect((await loadProject(fs, dir)).project).toMatchObject({ alphaTex: next.alphaTex, notes: next.notes });
  });

  it('旧工程继续读取独立文件；首次新保存副本失败也不会混用旧谱', async () => {
    class FaultFs extends MemoryFsAdapter {
      fail = false;
      override async writeFile(path: string, data: Uint8Array) {
        if (this.fail && path.endsWith('score.alphaTex.tmp')) throw new Error('mirror failed');
        return super.writeFile(path, data);
      }
    }
    const fs = new FaultFs();
    const legacy = makeProject();
    const dir = projectDirName(legacy.name, legacy.id);
    await fs.writeFile(`projects/${dir}/project.json`, jsonToBytes(legacy));
    await fs.writeFile(`projects/${dir}/transcript/score.alphaTex`, textToBytes('legacy standalone score'));
    const overlay = [makeFretEdit(NOTES[0], 5, 2, 1)];
    await fs.writeFile(`projects/${dir}/editOverlay.json`, jsonToBytes(overlay));
    const loaded = await loadProject(fs, dir);
    expect(loaded.alphaTexFile).toBe('legacy standalone score');
    expect(loaded.project.editOverlay).toEqual(overlay);
    fs.fail = true;
    const next = { ...loaded.project, alphaTex: 'new committed score', notes: [NOTES[1]], editOverlay: [] };
    await expect(saveProject(fs, next)).rejects.toThrow('mirror failed');
    expect((await loadProject(fs, dir)).project).toMatchObject({ alphaTex: next.alphaTex, notes: next.notes, editOverlay: [] });
  });

  it.each(['copy', 'manifest', 'publish'])('改名 %s 失败时原工程、音频和历史仍完整可读', async (failure) => {
    class FaultFs extends MemoryFsAdapter {
      fail = false;
      override async writeFile(path: string, data: Uint8Array) {
        if (this.fail && path.includes('.rename-') &&
            ((failure === 'copy' && /\/source\/audio-[a-f0-9]{64}\.wav$/.test(path)) ||
             (failure === 'manifest' && path.endsWith('project.json.tmp')))) throw new Error('rename failed');
        return super.writeFile(path, data);
      }
      override async move(from: string, to: string) {
        if (this.fail && failure === 'publish' && from.includes('.rename-') && !from.endsWith('.json.tmp')) throw new Error('rename failed');
        return super.move(from, to);
      }
    }
    const fs = new FaultFs();
    const previous = await saveProject(fs, makeProject(), { audioBytes: textToBytes('source audio'), audioFileName: 'demo.wav' });
    const oldDir = projectDirName(previous.name, previous.id);
    await writeSnapshot(fs, oldDir, { at: 1, label: 'history', alphaTex: TEX });
    fs.fail = true;
    await expect(renameProject(fs, previous, '新名字')).rejects.toThrow('rename failed');
    expect((await loadProject(fs, oldDir)).project).toEqual(previous);
    expect(bytesToText((await readEmbeddedAudio(fs, oldDir, previous.audio!))!)).toBe('source audio');
    expect((await latestSnapshot(fs, oldDir))?.alphaTex).toBe(TEX);
    expect((await listProjects(fs)).map((p) => p.name)).toEqual([previous.name]);
  });

  it('相同 slug 的名称也持久更新；已存在的目标目录不能覆盖', async () => {
    const fs = new MemoryFsAdapter();
    const previous = await saveProject(fs, { ...makeProject(), name: 'a/b' });
    const renamed = await renameProject(fs, previous, 'a:b');
    const dir = projectDirName(previous.name, previous.id);
    expect((await loadProject(fs, dir)).project.name).toBe('a:b');
    const other = await saveProject(fs, { ...renamed, name: 'taken' });
    await expect(renameProject(fs, renamed, 'taken')).rejects.toThrow('已存在');
    expect((await loadProject(fs, dir)).project.name).toBe('a:b');
    expect((await loadProject(fs, projectDirName(other.name, other.id))).project.name).toBe('taken');
  });

  it('改名保留磁盘最新提交、音频、历史及空目录，不用陈旧调用对象覆盖数据', async () => {
    const fs = new MemoryFsAdapter();
    const stale = makeProject();
    const latest = await saveProject(fs, { ...stale, alphaTex: 'latest score', notes: [NOTES[1]] },
      { audioBytes: textToBytes('audio'), audioFileName: 'demo.wav' });
    const oldDir = projectDirName(stale.name, stale.id);
    await writeSnapshot(fs, oldDir, { at: 42, label: 'history', alphaTex: TEX });
    await fs.writeFile(`projects/${oldDir}/empty/placeholder`, new Uint8Array());
    await fs.remove(`projects/${oldDir}/empty/placeholder`);
    const renamed = await renameProject(fs, stale, 'renamed');
    const dir = projectDirName(renamed.name, renamed.id);
    expect((await loadProject(fs, dir)).project).toMatchObject({ name: 'renamed', alphaTex: latest.alphaTex, notes: latest.notes });
    expect(bytesToText((await readEmbeddedAudio(fs, dir, renamed.audio!))!)).toBe('audio');
    expect((await latestSnapshot(fs, dir))?.at).toBe(42);
    expect(await fs.exists(`projects/${dir}/empty`)).toBe(true);
    expect(await fs.exists(`projects/${oldDir}`)).toBe(false);
  });

  it('发布后旧目录清理失败会明确报告新位置，不能删除已完成的新工程', async () => {
    class CleanupFaultFs extends MemoryFsAdapter {
      failPath = '';
      override async remove(path: string) {
        if (path === this.failPath) throw new Error('old directory busy');
        return super.remove(path);
      }
    }
    const fs = new CleanupFaultFs();
    const previous = await saveProject(fs, makeProject());
    const oldDir = projectDirName(previous.name, previous.id);
    const newDir = projectDirName('renamed', previous.id);
    fs.failPath = `projects/${oldDir}`;
    await expect(renameProject(fs, previous, 'renamed')).rejects.toThrow(`新工程已保存于 ${newDir}`);
    expect((await loadProject(fs, oldDir)).project).toEqual(previous);
    expect((await loadProject(fs, newDir)).project).toMatchObject({ name: 'renamed', notes: previous.notes, alphaTex: previous.alphaTex });
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
