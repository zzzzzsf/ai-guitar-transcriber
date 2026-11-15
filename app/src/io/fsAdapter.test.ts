import { describe, expect, it, vi } from 'vitest';
import {
  basename,
  dirname,
  joinPath,
  jsonToBytes,
  MemoryFsAdapter,
  NodeFsAdapter,
  FsNotFoundError,
  FsPathError,
  OpfsFsAdapter,
  sha256Hex,
  textToBytes,
  bytesToText,
  writeFileAtomic,
} from './fsAdapter';

describe('路径工具', () => {
  it('joinPath 合并并压缩重复斜杠', () => {
    expect(joinPath('a', 'b/', '/c')).toBe('a/b/c');
    expect(joinPath('', 'x')).toBe('x');
  });
  it('dirname / basename', () => {
    expect(dirname('a/b/c.json')).toBe('a/b');
    expect(basename('a/b/c.json')).toBe('c.json');
  });
});

describe('MemoryFsAdapter', () => {
  it('写读往返 + 自动建父目录 + exists', async () => {
    const fs = new MemoryFsAdapter();
    await fs.writeFile('projects/demo.agtp/project.json', textToBytes('{}'));
    expect(await fs.exists('projects/demo.agtp/project.json')).toBe(true);
    expect(bytesToText(await fs.readFile('projects/demo.agtp/project.json'))).toBe('{}');
    expect(await fs.exists('projects/demo.agtp/missing.json')).toBe(false);
  });

  it('readFile 不存在抛 FsNotFoundError', async () => {
    const fs = new MemoryFsAdapter();
    await expect(fs.readFile('nope')).rejects.toBeInstanceOf(FsNotFoundError);
  });

  it('list 返回文件与子目录，remove 递归删除', async () => {
    const fs = new MemoryFsAdapter({
      'a/one.txt': '1',
      'a/two.txt': '22',
      'a/sub/deep.txt': 'x',
    });
    const entries = await fs.list('a');
    expect(entries.map((e) => e.path)).toEqual(['one.txt', 'sub', 'two.txt']);
    expect(entries.find((e) => e.path === 'one.txt')?.size).toBe(1);
    // dir 字段显式判别（0 字节文件不得误判为目录）
    expect(entries.find((e) => e.path === 'sub')?.dir).toBe(true);
    expect(entries.find((e) => e.path === 'one.txt')?.dir).toBe(false);
    await fs.remove('a/sub');
    expect(await fs.exists('a/sub/deep.txt')).toBe(false);
  });

  it('0 字节文件 dir=false（不得用 size 猜目录）', async () => {
    const fs = new MemoryFsAdapter({ 'a/empty.wav': new Uint8Array(0) });
    expect((await fs.list('a'))[0]).toEqual({ path: 'empty.wav', size: 0, dir: false });
  });

  it('move 保持数据', async () => {
    const fs = new MemoryFsAdapter({ 'x.tmp': 'data' });
    await fs.move('x.tmp', 'x.json');
    expect(bytesToText(await fs.readFile('x.json'))).toBe('data');
    expect(await fs.exists('x.tmp')).toBe(false);
  });

  it('writeFileAtomic：.tmp 不残留', async () => {
    const fs = new MemoryFsAdapter();
    await writeFileAtomic(fs, 'a/b.json', jsonToBytes({ v: 1 }));
    expect(await fs.exists('a/b.json')).toBe(true);
    expect(await fs.exists('a/b.json.tmp')).toBe(false);
  });
});

describe('NodeFsAdapter（真实临时目录）', () => {
  it('写读列移动 + 原子写', async () => {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = join(tmpdir(), `agtp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fs = await NodeFsAdapter.create(root);

    await fs.writeFile('proj.agtp/project.json', textToBytes('{"ok":true}'));
    await fs.writeFile('proj.agtp/transcript/score.alphaTex', textToBytes('\\tempo 120'));
    expect(bytesToText(await fs.readFile('proj.agtp/project.json'))).toBe('{"ok":true}');

    const entries = await fs.list('proj.agtp');
    expect(entries.map((e) => e.path).sort()).toEqual(['project.json', 'transcript']);

    await writeFileAtomic(fs, 'proj.agtp/project.json', textToBytes('{"ok":2}'));
    expect(await fs.exists('proj.agtp/project.json.tmp')).toBe(false);
    expect(bytesToText(await fs.readFile('proj.agtp/project.json'))).toBe('{"ok":2}');

    await fs.remove('proj.agtp');
    expect(await fs.exists('proj.agtp/project.json')).toBe(false);
  });
});

describe('NodeFsAdapter 真实链接隔离（全部位于同一个临时夹具）', () => {
  it('symlink/junction 指向夹具内 root 外的兄弟目录时，各入口均拒绝', async (context) => {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const { tmpdir } = await import('node:os');
    const temporaryBase = path.resolve(tmpdir());
    const fixture = await fsp.mkdtemp(path.join(temporaryBase, 'agtp-boundary-'));
    const root = path.join(fixture, 'root');
    const outside = path.join(fixture, 'outside');
    try {
      await fsp.mkdir(root);
      await fsp.mkdir(outside);
      await fsp.writeFile(path.join(outside, 'keep.txt'), 'unchanged');
      try {
        await fsp.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
          context.skip(`当前系统无法创建链接：${code}；此真实链接测试未覆盖`);
        }
        throw error;
      }
      const fs = await NodeFsAdapter.create(root);
      await fs.writeFile('inside.txt', textToBytes('inside'));
      for (const operation of [
        () => fs.readFile('link/keep.txt'), () => fs.writeFile('link/keep.txt', textToBytes('bad')),
        () => fs.remove('link/keep.txt'), () => fs.list('link'), () => fs.exists('link/keep.txt'),
        () => fs.move('link/keep.txt', 'moved.txt'), () => fs.move('inside.txt', 'link/moved.txt'),
      ]) await expect(operation()).rejects.toBeInstanceOf(FsPathError);
      expect(await fsp.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('unchanged');
      expect(bytesToText(await fs.readFile('inside.txt'))).toBe('inside');
    } finally {
      // Only delete the exact directory returned by mkdtemp, under tmpdir.
      if (path.dirname(path.resolve(fixture)) !== temporaryBase) throw new Error('Unexpected fixture path');
      await fsp.rm(fixture, { recursive: true, force: true });
    }
  });
});

describe('NodeFsAdapter 根路径隔离（仅注入 fs，不访问外部文件）', () => {
  async function fixture() {
    const path = await import('node:path');
    const root = path.resolve('virtual-adapter-root');
    const api = {
      lstat: vi.fn(async (_path: string) => ({ isSymbolicLink: (): boolean => false })),
      realpath: vi.fn(async (value: string) => value),
      readFile: vi.fn(async () => textToBytes('inside')),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ size: 6 })),
      readdir: vi.fn(async () => []),
    };
    const fs = new NodeFsAdapter(root, api as unknown as typeof import('node:fs/promises'), path);
    return { fs, api, root, path };
  }

  it.each(['../outside', 'safe/../../outside', '..\\outside', '/absolute', '\\rooted',
    'C:\\absolute', 'C:drive-relative', '\\\\server\\share\\x', '\\\\?\\C:\\x',
    'file:stream', 'dir/.. /outside', 'file\0name'])('所有入口拒绝路径 %s，且不发出任何 fs 调用', async (bad) => {
    const { fs, api } = await fixture();
    for (const operation of [
      () => fs.readFile(bad), () => fs.writeFile(bad, textToBytes('x')),
      () => fs.exists(bad), () => fs.list(bad), () => fs.remove(bad),
      () => fs.move(bad, 'valid'), () => fs.move('valid', bad),
    ]) await expect(operation()).rejects.toBeInstanceOf(FsPathError);
    for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  });

  it('绝对路径即使指向 root 内也拒绝；禁止删除/移动 root 本身', async () => {
    const { fs, root, path, api } = await fixture();
    await expect(fs.readFile(path.join(root, 'inside'))).rejects.toBeInstanceOf(FsPathError);
    await expect(fs.remove('')).rejects.toBeInstanceOf(FsPathError);
    await expect(fs.remove('.')).rejects.toBeInstanceOf(FsPathError);
    await expect(fs.move('.', 'renamed-root')).rejects.toBeInstanceOf(FsPathError);
    expect(api.rm).not.toHaveBeenCalled();
    expect(api.rename).not.toHaveBeenCalled();
  });

  it('有效相对路径正常工作，正反斜杠都映射到同一根目录', async () => {
    const { fs, root, path, api } = await fixture();
    await fs.writeFile('./dir/file', textToBytes('data'));
    await fs.readFile('dir\\file');
    expect(api.writeFile).toHaveBeenCalledWith(path.join(root, 'dir', 'file'), textToBytes('data'));
    expect(api.readFile).toHaveBeenCalledWith(path.join(root, 'dir', 'file'));
    expect(await fs.list('')).toEqual([]);
  });

  it.each(['symlink', 'realpath'])('已有父目录 %s 越界：读写、move 两端、remove 均拒绝', async (mode) => {
    const { fs, root, path, api } = await fixture();
    const link = path.join(root, 'link');
    if (mode === 'symlink') api.lstat.mockImplementation(async (value) => ({ isSymbolicLink: () => value === link }));
    else api.realpath.mockImplementation(async (value) => value === link ? path.resolve(root, '../outside-fixture') : value);
    for (const operation of [
      () => fs.readFile('link/file'), () => fs.writeFile('link/file', textToBytes('x')),
      () => fs.remove('link/file'), () => fs.exists('link/file'), () => fs.list('link'),
      () => fs.move('link/file', 'safe'), () => fs.move('safe', 'link/file'),
    ]) await expect(operation()).rejects.toBeInstanceOf(FsPathError);
    for (const call of [api.readFile, api.writeFile, api.rm, api.mkdir, api.rename, api.readdir]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('祖先目录被替换为链接后拒绝访问，不把外部物理根重新当合法根', async () => {
    const { fs, path, api } = await fixture();
    const ancestor = path.dirname(path.resolve('virtual-adapter-root'));
    api.lstat.mockImplementation(async (value) => ({
      isSymbolicLink: () => value === ancestor,
    }));
    for (const operation of [
      () => fs.readFile('inside'), () => fs.writeFile('inside', textToBytes('x')),
      () => fs.exists('inside'), () => fs.list(''), () => fs.remove('inside'),
      () => fs.move('inside', 'safe'),
    ]) await expect(operation()).rejects.toBeInstanceOf(FsPathError);
    for (const call of [api.readFile, api.writeFile, api.rm, api.rename, api.readdir]) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});

describe('OpfsFsAdapter（node 下用内存 fake handle 测逻辑分支）', () => {
  type Faults = { onWrite?: (path: string) => void; onClose?: (path: string) => void;
    onCreateDir?: (path: string) => void; onRemove?: (path: string) => void };
  class FakeFileHandle {
    readonly kind = 'file' as const;
    constructor(public name: string, public data: Uint8Array, private path = name, private faults: Faults = {}) {}
    async getFile(): Promise<File> {
      const data = this.data;
      return { size: data.length, arrayBuffer: async () => data.slice().buffer } as unknown as File;
    }
    async createWritable(): Promise<FileSystemWritableFileStream> {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk: ArrayBuffer) => {
          this.faults.onWrite?.(this.path);
          chunks.push(new Uint8Array(chunk));
        },
        close: async () => {
          this.faults.onClose?.(this.path);
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          this.data = out;
        },
      } as unknown as FileSystemWritableFileStream;
    }
  }

  class FakeDirHandle {
    readonly kind = 'directory' as const;
    constructor(
      public name: string,
      public files = new Map<string, FakeFileHandle>(),
      public dirs = new Map<string, FakeDirHandle>(),
      private path = '',
      public faults: Faults = {},
    ) {}
    async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
      if (this.files.has(name)) throw new DOMException('Is a file', 'TypeMismatchError');
      let d = this.dirs.get(name);
      if (!d) {
        if (!opts?.create) throw new DOMException('Missing directory', 'NotFoundError');
        const path = this.path ? `${this.path}/${name}` : name;
        this.faults.onCreateDir?.(path);
        d = new FakeDirHandle(name, new Map(), new Map(), path, this.faults);
        this.dirs.set(name, d);
      }
      return d as unknown as FileSystemDirectoryHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandle> {
      if (this.dirs.has(name)) throw new DOMException('Is a directory', 'TypeMismatchError');
      let f = this.files.get(name);
      if (!f) {
        if (!opts?.create) throw new DOMException('Missing file', 'NotFoundError');
        f = new FakeFileHandle(name, new Uint8Array(0), this.path ? `${this.path}/${name}` : name, this.faults);
        this.files.set(name, f);
      }
      return f as unknown as FileSystemFileHandle;
    }
    async removeEntry(name: string): Promise<void> {
      this.faults.onRemove?.(this.path ? `${this.path}/${name}` : name);
      if (!this.files.has(name) && !this.dirs.has(name)) throw new DOMException('Missing entry', 'NotFoundError');
      this.files.delete(name);
      this.dirs.delete(name);
    }
    async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, FakeFileHandle | FakeDirHandle]> {
      yield* this.files;
      yield* this.dirs;
    }
  }

  function makeFs() {
    return OpfsFsAdapter.fromRoot(new FakeDirHandle('root') as unknown as FileSystemDirectoryHandle);
  }

  it('node 无 navigator.storage → isSupported=false（create 会拒绝）', () => {
    expect(OpfsFsAdapter.isSupported()).toBe(false);
  });

  it('写读往返 + 自动建父目录', async () => {
    const fs = makeFs();
    await fs.writeFile('projects/a.agtp/project.json', textToBytes('{"v":1}'));
    expect(bytesToText(await fs.readFile('projects/a.agtp/project.json'))).toBe('{"v":1}');
  });

  it('exists：文件与目录都命中，缺路径 false', async () => {
    const fs = makeFs();
    await fs.writeFile('a/b/c.txt', textToBytes('x'));
    expect(await fs.exists('a/b/c.txt')).toBe(true);
    expect(await fs.exists('a/b')).toBe(true);
    expect(await fs.exists('a/zzz')).toBe(false);
  });

  it('list：文件 dir=false 带真实 size，子目录 dir=true', async () => {
    const fs = makeFs();
    await fs.writeFile('d/one.txt', textToBytes('12345'));
    await fs.writeFile('d/sub/two.txt', textToBytes('1'));
    const entries = await fs.list('d');
    expect(entries).toContainEqual({ path: 'one.txt', size: 5, dir: false });
    expect(entries).toContainEqual({ path: 'sub', size: 0, dir: true });
  });

  it('move（copy+delete 降级）与 remove 递归', async () => {
    const fs = makeFs();
    await fs.writeFile('a/x.tmp', textToBytes('data'));
    await fs.move('a/x.tmp', 'a/x.json');
    expect(bytesToText(await fs.readFile('a/x.json'))).toBe('data');
    await expect(fs.readFile('a/x.tmp')).rejects.toBeInstanceOf(FsNotFoundError);

    await fs.writeFile('a/deep/leaf.txt', textToBytes('l'));
    await fs.remove('a');
    expect(await fs.exists('a/deep/leaf.txt')).toBe(false);
  });

  it('writeFileAtomic 走 OPFS move 路径不留 .tmp', async () => {
    const fs = makeFs();
    await writeFileAtomic(fs, 'p/c.json', jsonToBytes({ ok: true }));
    expect(await fs.exists('p/c.json')).toBe(true);
    expect(await fs.exists('p/c.json.tmp')).toBe(false);
  });

  it('目录 move 保留完整工程、多层内容及空目录，成功后才删除源', async () => {
    const root = new FakeDirHandle('root');
    const fs = OpfsFsAdapter.fromRoot(root as unknown as FileSystemDirectoryHandle);
    await fs.writeFile('source/project.json', textToBytes('manifest'));
    await fs.writeFile('source/transcript/score.alphaTex', textToBytes('score'));
    await fs.writeFile('source/history/deep/snapshot.json', textToBytes('history'));
    const source = await root.getDirectoryHandle('source');
    await source.getDirectoryHandle('empty', { create: true });
    let removedSource = false;
    root.faults.onRemove = (path) => {
      if (path === 'source') {
        const dest = root.dirs.get('destination')!;
        expect(dest.files.get('project.json')?.data).toEqual(textToBytes('manifest'));
        expect(dest.dirs.get('transcript')?.files.get('score.alphaTex')?.data).toEqual(textToBytes('score'));
        expect(dest.dirs.get('empty')).toBeDefined();
        removedSource = true;
      }
    };
    await fs.move('source', 'destination');
    expect(removedSource).toBe(true);
    expect(await fs.exists('source')).toBe(false);
    expect(bytesToText(await fs.readFile('destination/history/deep/snapshot.json'))).toBe('history');
  });

  it.each(['write', 'close', 'directory'])('目录复制 %s 失败不会删除源，清理仅限新目标', async (phase) => {
    const root = new FakeDirHandle('root');
    const fs = OpfsFsAdapter.fromRoot(root as unknown as FileSystemDirectoryHandle);
    await fs.writeFile('source/a.json', textToBytes('a'));
    await fs.writeFile('source/sub/score.alphaTex', textToBytes('score'));
    await fs.writeFile('unrelated/keep', textToBytes('keep'));
    const fail = (path: string) => {
      if (path.startsWith('destination/sub')) throw new Error(`injected ${phase}`);
    };
    if (phase === 'write') root.faults.onWrite = fail;
    else if (phase === 'close') root.faults.onClose = fail;
    else root.faults.onCreateDir = fail;
    await expect(fs.move('source', 'destination')).rejects.toThrow(`injected ${phase}`);
    expect(bytesToText(await fs.readFile('source/a.json'))).toBe('a');
    expect(bytesToText(await fs.readFile('source/sub/score.alphaTex'))).toBe('score');
    expect(bytesToText(await fs.readFile('unrelated/keep'))).toBe('keep');
    expect(await fs.exists('destination')).toBe(false);
  });

  it('目标已有目录时拒绝合并，同路径移动保持内容；拒绝子目录迁移', async () => {
    const fs = makeFs();
    await fs.writeFile('source/project.json', textToBytes('source'));
    await fs.writeFile('destination/project.json', textToBytes('destination'));
    await expect(fs.move('source', 'destination')).rejects.toThrow('已存在');
    await expect(fs.move('source', 'source/child')).rejects.toBeInstanceOf(FsPathError);
    await fs.move('source/project.json', 'source/project.json');
    expect(bytesToText(await fs.readFile('source/project.json'))).toBe('source');
    expect(bytesToText(await fs.readFile('destination/project.json'))).toBe('destination');
  });

  it('源目录删除失败时保留已经完成的目标副本', async () => {
    const root = new FakeDirHandle('root');
    const fs = OpfsFsAdapter.fromRoot(root as unknown as FileSystemDirectoryHandle);
    await fs.writeFile('source/project.json', textToBytes('manifest'));
    root.faults.onRemove = (path) => { if (path === 'source') throw new Error('source busy'); };
    await expect(fs.move('source', 'destination')).rejects.toThrow('source busy');
    expect(bytesToText(await fs.readFile('source/project.json'))).toBe('manifest');
    expect(bytesToText(await fs.readFile('destination/project.json'))).toBe('manifest');
  });
});

describe('sha256Hex', () => {
  it('标准测试向量', async () => {
    expect(await sha256Hex(textToBytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
