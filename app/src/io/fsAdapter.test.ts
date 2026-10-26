import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  joinPath,
  jsonToBytes,
  MemoryFsAdapter,
  NodeFsAdapter,
  FsNotFoundError,
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

describe('OpfsFsAdapter（node 下用内存 fake handle 测逻辑分支）', () => {
  class FakeFileHandle {
    readonly kind = 'file' as const;
    constructor(public name: string, public data: Uint8Array) {}
    async getFile(): Promise<File> {
      const data = this.data;
      return { size: data.length, arrayBuffer: async () => data.slice().buffer } as unknown as File;
    }
    async createWritable(): Promise<FileSystemWritableFileStream> {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk: ArrayBuffer) => chunks.push(new Uint8Array(chunk)),
        close: async () => {
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
    ) {}
    async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
      let d = this.dirs.get(name);
      if (!d) {
        if (!opts?.create) throw new Error('NotFoundError');
        d = new FakeDirHandle(name);
        this.dirs.set(name, d);
      }
      return d as unknown as FileSystemDirectoryHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandle> {
      let f = this.files.get(name);
      if (!f) {
        if (!opts?.create) throw new Error('NotFoundError');
        f = new FakeFileHandle(name, new Uint8Array(0));
        this.files.set(name, f);
      }
      return f as unknown as FileSystemFileHandle;
    }
    async removeEntry(name: string): Promise<void> {
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
});

describe('sha256Hex', () => {
  it('标准测试向量', async () => {
    expect(await sha256Hex(textToBytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
