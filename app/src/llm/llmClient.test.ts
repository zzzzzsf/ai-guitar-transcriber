import { describe, expect, it } from 'vitest';
import { chatWith, createChat, extractJson, LlmError, redact, type LlmConfig, type LlmMessage } from './llmClient';

const CONFIG: LlmConfig = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  apiKey: 'sk-test-1234567890',
};

type Call = { url: string; headers: Record<string, string>; body: any };

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

function recorder(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const call: Call = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    return handler(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const MSGS: LlmMessage[] = [{ role: 'user', content: '你好' }];

describe('chatWith 请求构造', () => {
  it('拼 /chat/completions、带 Bearer、映射响应文本与 usage', async () => {
    const { calls, fetchImpl } = recorder(() => okResponse('回声'));
    const out = await chatWith(CONFIG, MSGS, { fetchImpl });
    expect(out.text).toBe('回声');
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test-1234567890');
    expect(calls[0].body.model).toBe('deepseek-v4-pro');
    expect(calls[0].body.messages).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('无 Key 不带 Authorization（本地 Ollama）', async () => {
    const { calls, fetchImpl } = recorder(() => okResponse('ok'));
    await chatWith({ ...CONFIG, apiKey: undefined }, MSGS, { fetchImpl });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('claude 厂商附加浏览器直连头', async () => {
    const { calls, fetchImpl } = recorder(() => okResponse('ok'));
    await chatWith(
      { providerId: 'claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-x123456' },
      MSGS,
      { fetchImpl },
    );
    expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('temperature / maxTokens / jsonMode 进请求体', async () => {
    const { calls, fetchImpl } = recorder(() => okResponse('{}'));
    await chatWith(CONFIG, MSGS, { fetchImpl, temperature: 0.2, maxTokens: 512, jsonMode: true });
    expect(calls[0].body.temperature).toBe(0.2);
    expect(calls[0].body.max_tokens).toBe(512);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('chatWith 错误分类与重试', () => {
  it('401 → auth 且不重试', async () => {
    const { calls, fetchImpl } = recorder(() => new Response('bad key', { status: 401 }));
    await expect(chatWith(CONFIG, MSGS, { fetchImpl, backoffBaseMs: 1 })).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'auth',
    });
    expect(calls).toHaveLength(1);
  });

  it('429 → 按 Retry-After 语义退避重试后成功', async () => {
    const { calls, fetchImpl } = recorder((_c, n) =>
      n === 1 ? new Response('rate limited', { status: 429 }) : okResponse('done'),
    );
    const out = await chatWith(CONFIG, MSGS, { fetchImpl, backoffBaseMs: 1 });
    expect(out.text).toBe('done');
    expect(calls).toHaveLength(2);
  });

  it('429 带 Retry-After 头 → 退避不快于服务端要求（0s 立即重试）', async () => {
    const { calls, fetchImpl } = recorder((_c, n) =>
      n === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : okResponse('done'),
    );
    const out = await chatWith(CONFIG, MSGS, { fetchImpl, backoffBaseMs: 10_000 });
    expect(out.text).toBe('done');
    expect(calls).toHaveLength(2);
  }, 2_000);

  it('5xx → 重试耗尽后抛 server', async () => {
    const { calls, fetchImpl } = recorder(() => new Response('boom', { status: 502 }));
    await expect(chatWith(CONFIG, MSGS, { fetchImpl, backoffBaseMs: 1, retries: 2 })).rejects.toMatchObject({
      kind: 'server',
      status: 502,
    });
    expect(calls).toHaveLength(3); // 首发 + 2 重试
  });

  it('网络异常 → 重试后成功', async () => {
    const { calls, fetchImpl } = recorder((_c, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return okResponse('ok');
    });
    const out = await chatWith(CONFIG, MSGS, { fetchImpl, backoffBaseMs: 1 });
    expect(out.text).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('服务端错误消息中的 Key 被脱敏', async () => {
    const { fetchImpl } = recorder(() =>
      new Response('invalid key sk-test-1234567890 provided', { status: 500 }),
    );
    const err = await chatWith(CONFIG, MSGS, { fetchImpl, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).not.toContain('sk-test-1234567890');
    expect(err.message).toContain('sk-***');
  });

  it('超时 → timeout 错误', async () => {
    // mock fetch 挂住但尊重 abort 信号（真实 fetch 行为）
    const fetchImpl = (async (_url: any, init: any) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(chatWith(CONFIG, MSGS, { fetchImpl, timeoutMs: 40 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('外部 signal 预先 abort → aborted 且不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, fetchImpl } = recorder(() => okResponse('x'));
    await expect(
      chatWith(CONFIG, MSGS, { fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toHaveLength(0);
  });

  it('jsonMode 不被支持 → 去掉 response_format 重试一次', async () => {
    const { calls, fetchImpl } = recorder((_call, n) =>
      n === 1
        ? new Response('response_format json_object is not supported', { status: 400 })
        : okResponse('{}'),
    );
    const out = await chatWith(CONFIG, MSGS, { fetchImpl, jsonMode: true });
    expect(out.text).toBe('{}');
    expect(calls).toHaveLength(2);
    expect(calls[0].body.response_format).toBeDefined();
    expect(calls[1].body.response_format).toBeUndefined();
  });

  it('响应缺 choices → parse 错误', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ object: 'chat.completion' }), { status: 200 })) as unknown as typeof fetch;
    await expect(chatWith(CONFIG, MSGS, { fetchImpl })).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('createChat（UI 接线预留门面）', () => {
  it('返回可用的 chat 函数（完整请求链路）', async () => {
    const { calls, fetchImpl } = recorder(() => okResponse('via facade'));
    const chat = createChat(CONFIG);
    const out = await chat(MSGS, { fetchImpl });
    expect(out.text).toBe('via facade');
    expect(calls[0].body.model).toBe('deepseek-v4-pro');
  });

  it('非法 baseUrl / 缺模型 ID 在创建时即拒绝', () => {
    expect(() => createChat({ ...CONFIG, baseUrl: 'ftp://x' })).toThrow(LlmError);
    expect(() => createChat({ ...CONFIG, model: '' })).toThrow(LlmError);
  });
});

describe('extractJson', () => {
  it('纯 JSON 对象', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('纯 JSON 数组', () => {
    expect(extractJson('[1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] });
  });
  it('Markdown 围栏', () => {
    expect(extractJson('```json\n{"chords":[]}\n```')).toEqual({ ok: true, value: { chords: [] } });
  });
  it('前后带解释文字', () => {
    const text = '好的，以下是分析结果：\n{"chords":[{"bar":1,"name":"Em"}]}\n希望有帮助！';
    expect(extractJson(text)).toEqual({ ok: true, value: { chords: [{ bar: 1, name: 'Em' }] } });
  });
  it('字符串里的括号不破坏配平', () => {
    expect(extractJson('{"s":"}{[","n":2}')).toEqual({ ok: true, value: { s: '}{[', n: 2 } });
  });
  it('嵌套对象取最外层', () => {
    expect(extractJson('噪声 { "outer": { "inner": 1 } } 噪声')).toEqual({
      ok: true,
      value: { outer: { inner: 1 } },
    });
  });
  it('无 JSON → ok:false', () => {
    expect(extractJson('抱歉，我无法完成。').ok).toBe(false);
  });

  it('恶劣输入下性能线性（起点上限回归：24KB 括号垃圾 < 300ms）', () => {
    const junk = '分析如下 { 注意这不是 } JSON '.repeat(100);
    const text = `${junk}\n${'{'.repeat(20_000)}\n${junk}`;
    const t0 = performance.now();
    const result = extractJson(text);
    const elapsed = performance.now() - t0;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(300);
  });
});

describe('redact', () => {
  it('遮蔽 OpenAI/Anthropic/Gemini Key 与 id.secret 形态', () => {
    const out = redact('key=sk-abcdefgh1234 token=AIzaSyA1234567890abcd zhipu=abcdef12.abcd1234ef');
    expect(out).not.toContain('sk-abcdefgh1234');
    expect(out).not.toContain('AIzaSyA1234567890abcd');
    expect(out).toContain('sk-***');
    expect(out).toContain('AIza***');
  });
});
