/**
 * 统一文件系统抽象（Step 4 引擎底座）。
 *
 * 同一套接口跑三处运行时：
 * - 测试 / Electron 主进程：NodeFsAdapter（node:fs/promises，惰性加载避免进浏览器包）
 * - 浏览器（.agtp 工程、stems 缓存）：OpfsFsAdapter（OPFS 源私有文件系统）
 * - 单元测试：MemoryFsAdapter
 *
 * 路径约定：一律用 '/' 分隔、相对各自根目录，不做平台分隔符转换 ——
 * 适配器内部负责映射（node:fs 在 win32 也接受 '/'）。
 */
/** 目录条目 dir=true 且 size=0；文件条目 dir=false（0 字节文件是合法文件，勿用 size 判别） */
export type FsFile = { path: string; size: number; dir: boolean };

export interface FsAdapter {
  /** 文件不存在时抛 FsNotFoundError */
  readFile(path: string): Promise<Uint8Array>;
  /** 自动创建父目录；覆盖已存在文件 */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 文件或目录（目录递归删除）；不存在时静默 */
  remove(path: string): Promise<void>;
  /** 列出目录下一层条目（文件与子目录，子目录 size = 0）；不存在 → [] */
  list(path: string): Promise<FsFile[]>;
  /** 移动/重命名（原子写的依赖；OPFS 降级为 copy+delete） */
  move(from: string, to: string): Promise<void>;
}

export class FsNotFoundError extends Error {
  constructor(path: string) {
    super(`文件不存在: ${path}`);
    this.name = 'FsNotFoundError';
  }
}

export class FsPathError extends Error {
  constructor(path: string) {
    super(`非法文件路径，必须位于适配器根目录内：${path}`);
    this.name = 'FsPathError';
  }
}

/** Validate before normalization: never turn an absolute path into a relative one. */
function relativePath(path: string): string {
  if (/^[\\/]|^[a-z]:/i.test(path) || path.includes('\0')) throw new FsPathError(path);
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..' || /:|[. ]$/.test(part))) throw new FsPathError(path);
  return parts.join('/');
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== '' && p !== '.').join('/').replace(/\/+/g, '/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * 原子写：先写 `<path>.tmp` 再 move，避免写入中断留下半截 project.json
 * （§2.2 弃 zip 的理由之一就是“无事务性”，这里给 JSON 落盘补上）。
 */
export async function writeFileAtomic(fs: FsAdapter, path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.move(tmp, path);
}

// ---------- MemoryFsAdapter ----------

export class MemoryFsAdapter implements FsAdapter {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>(['']);

  constructor(seed?: Record<string, Uint8Array | string>) {
    if (seed) {
      for (const [path, data] of Object.entries(seed)) {
        const p = normalize(path);
        this.addAncestorDirs(p);
        this.files.set(p, typeof data === 'string' ? enc.encode(data) : data);
      }
    }
  }

  private addAncestorDirs(path: string): void {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      this.dirs.add(parts.join('/'));
      parts.pop();
    }
  }

  /** 测试辅助：直接读内部表 */
  peek(path: string): Uint8Array | undefined {
    return this.files.get(normalize(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(normalize(path));
    if (!data) throw new FsNotFoundError(path);
    return data;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const p = normalize(path);
    this.dirs.add(dirname(p) || '');
    this.files.set(p, data.slice());
  }

  async exists(path: string): Promise<boolean> {
    const p = normalize(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  async remove(path: string): Promise<void> {
    const p = normalize(path);
    this.files.delete(p);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${p}/`)) this.files.delete(key);
    }
    for (const d of [...this.dirs]) {
      if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
    }
  }

  async list(path: string): Promise<FsFile[]> {
    const dir = normalize(path);
    const out: FsFile[] = [];
    const seen = new Set<string>();
    for (const key of this.files.keys()) {
      if (dirname(key) !== dir) continue;
      out.push({ path: basename(key), size: this.files.get(key)!.length, dir: false });
      seen.add(basename(key));
    }
    for (const d of this.dirs) {
      if (d === '' || dirname(d) !== dir || seen.has(basename(d))) continue;
      out.push({ path: basename(d), size: 0, dir: true });
      seen.add(basename(d));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async move(from: string, to: string): Promise<void> {
    const src = normalize(from);
    const dst = normalize(to);
    const direct = this.files.get(src);
    if (direct) {
      // 文件移动
      this.addAncestorDirs(dst);
      this.files.set(dst, direct.slice());
      this.files.delete(src);
      return;
    }
    if (!this.dirs.has(src)) throw new FsNotFoundError(from);
    // 目录移动：前缀替换（文件 + 目录标记）
    this.addAncestorDirs(dst);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${src}/`)) {
        this.files.set(`${dst}${key.slice(src.length)}`, this.files.get(key)!);
        this.files.delete(key);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === src || d.startsWith(`${src}/`)) {
        this.dirs.add(`${dst}${d.slice(src.length)}`);
        this.dirs.delete(d);
      }
    }
    this.dirs.add(dst);
    this.dirs.delete(src);
  }
}

// ---------- NodeFsAdapter ----------

/**
 * Node 运行时适配器（Electron 主进程 / vitest）。根目录前缀必填，
 * 防止误写工程外路径。node:fs 惰性 import —— 浏览器 bundle 不会包含它。
 */
export class NodeFsAdapter implements FsAdapter {
  constructor(
    private readonly root: string,
    private readonly fsp: typeof import('node:fs/promises'),
    private readonly pathMod: typeof import('node:path'),
  ) {
    this.root = pathMod.resolve(root);
  }

  static async create(root: string): Promise<NodeFsAdapter> {
    const [fsp, pathMod] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    return new NodeFsAdapter(root, fsp, pathMod);
  }

  private abs(path: string): string {
    const result = this.pathMod.resolve(this.root, ...relativePath(path).split('/'));
    const relative = this.pathMod.relative(this.root, result);
    if (relative === '..' || relative.startsWith(`..${this.pathMod.sep}`) || this.pathMod.isAbsolute(relative)) {
      throw new FsPathError(path);
    }
    return result;
  }

  private async checked(path: string, allowRoot = false): Promise<string> {
    const absolute = this.abs(path);
    if (!allowRoot && absolute === this.root) throw new FsPathError(path);
    // Lexical containment alone does not stop an in-root symlink/junction
    // from redirecting a read or write outside. Reject links in the whole
    // physical ancestry too: an ancestor can be retargeted after this adapter
    // was constructed, while the root itself still looks like a plain directory.
    const relative = this.pathMod.relative(this.root, absolute);
    let current = this.root;
    let realRoot: string | undefined;
    const parts = relative ? relative.split(this.pathMod.sep) : [];
    for (let i = 0; i <= parts.length; i++) {
      try {
        if ((await this.fsp.lstat(current)).isSymbolicLink()) throw new FsPathError(path);
        let ancestor = this.pathMod.dirname(current);
        while (ancestor !== this.pathMod.dirname(ancestor)) {
          if ((await this.fsp.lstat(ancestor)).isSymbolicLink()) throw new FsPathError(path);
          ancestor = this.pathMod.dirname(ancestor);
        }
        const real = await this.fsp.realpath(current);
        realRoot ??= real;
        const physicalRelative = this.pathMod.relative(realRoot, real);
        if (physicalRelative === '..' || physicalRelative.startsWith(`..${this.pathMod.sep}`) ||
            this.pathMod.isAbsolute(physicalRelative)) throw new FsPathError(path);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') break;
        throw error;
      }
      if (i < parts.length) current = this.pathMod.join(current, parts[i]);
    }
    return absolute;
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.fsp.readFile(await this.checked(path)));
    } catch (e) {
      throw toNotFound(e, path);
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const abs = await this.checked(path);
    await this.fsp.mkdir(this.pathMod.dirname(abs), { recursive: true });
    await this.fsp.writeFile(abs, data);
  }

  async exists(path: string): Promise<boolean> {
    const absolute = await this.checked(path, true);
    try {
      await this.fsp.stat(absolute);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    await this.fsp.rm(await this.checked(path), { recursive: true, force: true });
  }

  async list(path: string): Promise<FsFile[]> {
    const absolute = await this.checked(path, true);
    try {
      const entries = await this.fsp.readdir(absolute, { withFileTypes: true });
      const out: FsFile[] = [];
      for (const e of entries) {
        const child = await this.checked(joinPath(relativePath(path), e.name));
        if (e.isDirectory()) out.push({ path: e.name, size: 0, dir: true });
        else {
          const st = await this.fsp.stat(child);
          out.push({ path: e.name, size: st.size, dir: false });
        }
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  async move(from: string, to: string): Promise<void> {
    // Validate both operands before any filesystem operation.
    this.abs(from);
    this.abs(to);
    const absFrom = await this.checked(from);
    const absTo = await this.checked(to);
    await this.fsp.mkdir(this.pathMod.dirname(absTo), { recursive: true });
    await this.fsp.rename(absFrom, absTo);
  }
}

function toNotFound(e: unknown, path: string): Error {
  const code = (e as { code?: string }).code;
  if (code === 'ENOENT') return new FsNotFoundError(path);
  return e as Error;
}

// ---------- OpfsFsAdapter ----------

/**
 * 浏览器 OPFS 适配器（.agtp 工程与 stems 缓存用）。
 * Files commit via createWritable().close(); directory move copies the entire
 * tree before deleting the source. A failed copy leaves the source intact.
 */
export class OpfsFsAdapter implements FsAdapter {
  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  static async create(rootDirName = '.agtp'): Promise<OpfsFsAdapter> {
    if (!this.isSupported()) throw new Error('当前浏览器不支持 OPFS（navigator.storage.getDirectory 缺失）');
    const base = await navigator.storage.getDirectory();
    const root = await base.getDirectoryHandle(rootDirName, { create: true });
    return new OpfsFsAdapter(root);
  }

  /** 测试注入：直接给根目录句柄（node 下用 fake handle 测逻辑分支） */
  static fromRoot(root: FileSystemDirectoryHandle): OpfsFsAdapter {
    return new OpfsFsAdapter(root);
  }

  private async dirFor(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const safe = relativePath(path);
    if (!safe) throw new FsPathError(path);
    const parts = safe.split('/');
    const name = parts.pop()!;
    let dir = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, name };
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      const { dir, name } = await this.dirFor(path, false);
      const handle = await dir.getFileHandle(name);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (isOpfsLookupMiss(error)) throw new FsNotFoundError(path);
      throw error;
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = await this.dirFor(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    // slice() 造精确大小的新缓冲，兼容 FileSystemWriteChunkType 的 ArrayBuffer 要求
    try {
      await writable.write(data.slice().buffer as ArrayBuffer);
      await writable.close();
    } catch (error) {
      if (typeof writable.abort === 'function') {
        try { await writable.abort(); }
        catch (abortError) { throw new AggregateError([error, abortError], 'OPFS 写入失败且流关闭失败'); }
      }
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    const safe = relativePath(path);
    if (!safe) return true;
    const parts = safe.split('/');
    const name = parts.pop()!;
    let dir = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false }).catch((error) => {
        if (isOpfsLookupMiss(error)) return null as never;
        throw error;
      });
      if (!dir) return false;
    }
    // 文件或目录皆可（与 Memory/Node 适配器行为一致）
    const file = await dir.getFileHandle(name).catch((error) => {
      if (isOpfsLookupMiss(error)) return null;
      throw error;
    });
    if (file) return true;
    const sub = await dir.getDirectoryHandle(name, { create: false }).catch((error) => {
      if (isOpfsLookupMiss(error)) return null;
      throw error;
    });
    return !!sub;
  }

  async remove(path: string): Promise<void> {
    try {
      const { dir, name } = await this.dirFor(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isOpfsNotFound(error)) throw error;
    }
  }

  async list(path: string): Promise<FsFile[]> {
    let dir = this.root;
    for (const part of relativePath(path).split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(part, { create: false }).catch((error) => {
        if (isOpfsLookupMiss(error)) return null as never;
        throw error;
      });
      if (!dir) return [];
    }
    const out: FsFile[] = [];
    for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (handle.kind === 'file') {
        const size = await (handle as FileSystemFileHandle).getFile().then((f) => f.size);
        out.push({ path: name, size, dir: false });
      } else {
        out.push({ path: name, size: 0, dir: true });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async move(from: string, to: string): Promise<void> {
    const sourcePath = relativePath(from);
    const targetPath = relativePath(to);
    if (!sourcePath || !targetPath) throw new FsPathError(!sourcePath ? from : to);
    if (sourcePath === targetPath) {
      if (!(await this.exists(sourcePath))) throw new FsNotFoundError(from);
      return;
    }
    if (targetPath.startsWith(`${sourcePath}/`) || sourcePath.startsWith(`${targetPath}/`)) {
      throw new FsPathError(to);
    }
    const source = await this.dirFor(sourcePath, false);
    const file = await source.dir.getFileHandle(source.name).catch((error) => {
      if (isOpfsLookupMiss(error)) return null;
      throw error;
    });
    if (file) {
      await this.writeFile(targetPath, new Uint8Array(await (await file.getFile()).arrayBuffer()));
      await source.dir.removeEntry(source.name);
      return;
    }
    const directory = await source.dir.getDirectoryHandle(source.name).catch((error) => {
      if (isOpfsNotFound(error)) throw new FsNotFoundError(from);
      throw error;
    });
    // Never merge/overwrite an existing tree: rollback must only remove a
    // destination created and owned by this move.
    if (await this.exists(targetPath)) throw new Error(`目标路径已存在：${to}`);
    // create:false narrows the remaining exists()/claim race: if another
    // operation creates the destination between the check and this call, we
    // refuse the existing handle instead of opening it for overwrite.
    const target = await this.dirFor(targetPath, true);
    const destination = await target.dir.getDirectoryHandle(target.name, { create: false }).catch((error) => {
      if (isOpfsNotFound(error)) return null as unknown as FileSystemDirectoryHandle;
      throw error;
    });
    if (destination) throw new Error(`目标路径已存在：${to}`);
    const created = await target.dir.getDirectoryHandle(target.name, { create: true });
    try {
      await this.copyDirectory(directory, created);
    } catch (error) {
      try { await target.dir.removeEntry(target.name, { recursive: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `OPFS 目录复制失败，源目录仍保留：${from}`); }
      throw error;
    }
    // Deletion failure must retain the completed destination as a recoverable
    // copy, even if the browser partially removed the source directory.
    await source.dir.removeEntry(source.name, { recursive: true });
  }

  private async copyDirectory(from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, handle] of from as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind === 'directory') {
        await this.copyDirectory(handle as FileSystemDirectoryHandle, await to.getDirectoryHandle(name, { create: true }));
      } else {
        const data = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
        const file = await to.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        try {
          await writable.write(data);
          await writable.close();
        } catch (error) {
          if (typeof writable.abort === 'function') {
            try { await writable.abort(); }
            catch (abortError) { throw new AggregateError([error, abortError], 'OPFS 目录复制写入失败且流关闭失败'); }
          }
          throw error;
        }
      }
    }
  }
}

function isOpfsNotFound(error: unknown): boolean {
  return (error as { name?: string }).name === 'NotFoundError';
}

function isOpfsLookupMiss(error: unknown): boolean {
  return isOpfsNotFound(error) || (error as { name?: string }).name === 'TypeMismatchError';
}

// ---------- 小工具 ----------

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToText(data: Uint8Array): string {
  return dec.decode(data);
}

export function textToBytes(text: string): Uint8Array {
  return enc.encode(text);
}

export function jsonToBytes(value: unknown): Uint8Array {
  return textToBytes(`${JSON.stringify(value, null, 2)}\n`);
}

/** WebCrypto SHA-256（node ≥18 与浏览器都有 crypto.subtle） */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
