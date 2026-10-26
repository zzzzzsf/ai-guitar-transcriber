import { describe, expect, it } from 'vitest';
import { sha256Hex, MemoryFsAdapter } from '../io/fsAdapter';
import { downloadModel, ModelDownloadError } from './modelDownloader';

const FULL = new TextEncoder().encode('0123456789abcdef0123456789abcdef'); // 32 字节

function bytes(n: number): Uint8Array {
  return FULL.slice(0, n);
}

function resp(status: number, body: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body.slice().buffer as ArrayBuffer, { status, headers });
}

describe('downloadModel（双源 + SHA-256 + 断点续传）', () => {
  it('全新下载：200 整包 → 校验通过 → .part 转正', async () => {
    const fs = new MemoryFsAdapter();
    const progress: number[] = [];
    const out = await downloadModel({
      sources: [{ url: 'https://hf.example/model.bin' }],
      destDir: 'models/v1',
      fileName: 'model.bin',
      expectedSha256: await sha256Hex(FULL),
      fs,
      fetchImpl: (async () => resp(200, FULL, { 'content-length': String(FULL.length) })) as typeof fetch,
      onProgress: (p) => progress.push(p.doneBytes),
    });
    expect(out.bytes).toBe(32);
    expect(out.resumedBytes).toBe(0);
    expect(await fs.exists('models/v1/model.bin')).toBe(true);
    expect(await fs.exists('models/v1/model.bin.part')).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('断点续传：.part 前缀 + 206 响应续接，hash 覆盖全量', async () => {
    const fs = new MemoryFsAdapter({ 'models/v1/model.bin.part': bytes(16) });
    let sentRange: string | undefined;
    const fetchImpl = (async (_url: any, init: any) => {
      sentRange = init.headers?.Range;
      return resp(206, FULL.slice(16), { 'content-length': String(16) });
    }) as unknown as typeof fetch;

    const out = await downloadModel({
      sources: [{ url: 'https://hf.example/model.bin' }],
      destDir: 'models/v1',
      fileName: 'model.bin',
      expectedSha256: await sha256Hex(FULL),
      fs,
      fetchImpl,
    });
    expect(sentRange).toBe('bytes=16-');
    expect(out.resumedBytes).toBe(16);
    expect(out.bytes).toBe(32);
    expect(out.sha256).toBe(await sha256Hex(FULL));
  });

  it('服务端忽略 Range（回 200）→ 从零整包重下', async () => {
    const fs = new MemoryFsAdapter({ 'models/v1/model.bin.part': bytes(16) }); // 脏前缀
    const fetchImpl = (async () => resp(200, FULL, { 'content-length': String(FULL.length) })) as typeof fetch;
    const out = await downloadModel({
      sources: [{ url: 'https://hf.example/model.bin' }],
      destDir: 'models/v1',
      fileName: 'model.bin',
      expectedSha256: await sha256Hex(FULL),
      fs,
      fetchImpl,
    });
    expect(out.resumedBytes).toBe(0);
    expect(out.bytes).toBe(32);
  });

  it('SHA-256 不符 → 删 .part 从零重下一次，仍不符 → 换镜像源成功', async () => {
    const fs = new MemoryFsAdapter({ 'models/v1/model.bin.part': bytes(8) }); // 脏前缀（校验必失败）
    const urls: string[] = [];
    const fetchImpl = (async (url: any) => {
      urls.push(String(url));
      // 主源两次（续传 + 全量重试）都喂错数据；镜像源给正确整包
      const isMirror = String(url).includes('mirror');
      return isMirror
        ? resp(200, FULL, { 'content-length': String(FULL.length) })
        : resp(200, bytes(20), { 'content-length': '20' });
    }) as unknown as typeof fetch;

    const out = await downloadModel({
      sources: [
        { url: 'https://hf.example/model.bin', label: 'HuggingFace' },
        { url: 'https://mirror.example/model.bin', label: '国内镜像' },
      ],
      destDir: 'models/v1',
      fileName: 'model.bin',
      expectedSha256: await sha256Hex(FULL),
      fs,
      fetchImpl,
    });
    expect(out.sha256).toBe(await sha256Hex(FULL));
    expect(urls).toEqual([
      'https://hf.example/model.bin', // attempt 0：带脏前缀续传（200 → 整包 20 字节，校验失败）
      'https://hf.example/model.bin', // attempt 1：从零重下（仍 20 字节，校验失败）
      'https://mirror.example/model.bin', // 换源成功
    ]);
  });

  it('主源 404 → 切镜像源', async () => {
    const fs = new MemoryFsAdapter();
    const fetchImpl = (async (url: any) => {
      return String(url).includes('mirror')
        ? resp(200, FULL, { 'content-length': String(FULL.length) })
        : resp(404, new TextEncoder().encode('not found'));
    }) as unknown as typeof fetch;
    const out = await downloadModel({
      sources: [{ url: 'https://hf.example/model.bin' }, { url: 'https://mirror.example/model.bin' }],
      destDir: 'models/v1',
      fileName: 'model.bin',
      fs,
      fetchImpl,
    });
    expect(out.bytes).toBe(32);
  });

  it('全部源失败 → ModelDownloadError 汇总各源原因', async () => {
    const fs = new MemoryFsAdapter();
    const fetchImpl = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadModel({
        sources: [{ url: 'https://a.example/m.bin', label: 'A' }, { url: 'https://b.example/m.bin', label: 'B' }],
        destDir: 'models/v1',
        fileName: 'model.bin',
        fs,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'ModelDownloadError',
      failures: [{ source: 'A', reason: expect.stringContaining('404') }, { source: 'B', reason: expect.stringContaining('404') }],
    });
  });

  it('416（.part 已是全量）→ 直接校验转正，不再要 body', async () => {
    const fs = new MemoryFsAdapter({ 'models/v1/model.bin.part': FULL });
    const fetchImpl = (async () => new Response(null, { status: 416, headers: { 'content-range': `bytes */${FULL.length}` } })) as unknown as typeof fetch;
    const out = await downloadModel({
      sources: [{ url: 'https://hf.example/model.bin' }],
      destDir: 'models/v1',
      fileName: 'model.bin',
      expectedSha256: await sha256Hex(FULL),
      fs,
      fetchImpl,
    });
    expect(out.bytes).toBe(32);
    expect(await fs.exists('models/v1/model.bin')).toBe(true);
  });

  it('取消 → ModelDownloadError（下载已取消）', async () => {
    const fs = new MemoryFsAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadModel({
        sources: [{ url: 'https://hf.example/model.bin' }],
        destDir: 'models/v1',
        fileName: 'model.bin',
        fs,
        fetchImpl: (async () => {
          throw new DOMException('aborted', 'AbortError');
        }) as unknown as typeof fetch,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('取消') });
  });

  it('空源列表直接报错', async () => {
    await expect(
      downloadModel({ sources: [], destDir: 'x', fileName: 'y', fs: new MemoryFsAdapter() }),
    ).rejects.toBeInstanceOf(ModelDownloadError);
  });
});
