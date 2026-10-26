/**
 * BYOK 大模型统一客户端（v4.0 §4.2 / v4.1 §1.3）。
 *
 * 2026-10 注册表核对后，七家预设厂商全部提供 OpenAI 兼容 /chat/completions
 * 端点（含 Gemini 官方 /v1beta/openai 与 Anthropic 官方 /v1 兼容层），
 * 因此单一 wire 分支即可；厂商差异只体现在附加请求头（如 Claude 浏览器直连）。
 *
 * 隐私铁律（§1.3）：
 * - Key 只作为参数在内存中流动，本模块不持久化、不打日志；
 * - 错误消息统一过 redact()，即使服务端回显 Authorization 也不会带出 Key。
 *
 * 装壳前（纯 web dev）直 fetch 部分厂商会撞 CORS —— 由调用方决定降级
 * （本地 chordDetector）；装壳后走主进程代理（§1.4 工作分解 5）。
 */
import type { CopilotProviderId } from '../copilot';

export type LlmConfig = {
  providerId: CopilotProviderId;
  /** 不带尾部斜杠的 OpenAI 兼容 base URL */
  baseUrl: string;
  model: string;
  /** 空 = 免鉴权端点（本地 Ollama 等） */
  apiKey?: string;
};

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmChatOptions = {
  temperature?: number;
  maxTokens?: number;
  /** 附加 response_format json_object；服务端不支持时自动去弃重试一次 */
  jsonMode?: boolean;
  timeoutMs?: number;
  /** 429/5xx/网络错误的额外重试次数（默认 2） */
  retries?: number;
  /** 退避基数，默认 800ms；测试注入 1 免等待 */
  backoffBaseMs?: number;
  signal?: AbortSignal;
  /** 测试注入；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
};

export type LlmChatResult = {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number };
};

export type LlmErrorKind =
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rateLimit'
  | 'server'
  | 'badRequest'
  | 'parse';

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
    /** 429/5xx/网络错误可安全重试 */
    public readonly retryable = false,
    /** 服务端 Retry-After（毫秒，已 cap）；重试退避取 max(常规退避, 此值) */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type LlmChat = (messages: LlmMessage[], opts?: LlmChatOptions) => Promise<LlmChatResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;

/** 去掉任何形如 sk-xxx / AIzaxxx / id.secret 的疑似密钥串，防日志/错误消息泄漏 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-ant-|sk-)[A-Za-z0-9_-]{6,}/g, '$1***')
    .replace(/\bAIza[A-Za-z0-9_-]{6,}\b/g, 'AIza***')
    .replace(/\b[A-Za-z0-9]{8}\.[A-Za-z0-9]{8,}\b/g, '***.***');
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function extraHeaders(providerId: CopilotProviderId): Record<string, string> {
  if (providerId === 'claude') {
    // Anthropic 兼容层允许浏览器直连的开关；装壳走主进程代理后自然失效
    return { 'anthropic-dangerous-direct-browser-access': 'true' };
  }
  return {};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError('aborted', '请求已取消'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Retry-After 秒数 → 毫秒（cap 30s；HTTP-date 形式不支持，返回 null 走常规退避） */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, 30_000);
}

/** 外部 signal + 超时合并成一个 AbortController */
function combinedSignal(timeoutMs: number, external?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new LlmError('timeout', `请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onExternalAbort = () => controller.abort(new LlmError('aborted', '请求已取消'));
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

async function requestOnce(
  config: LlmConfig,
  messages: LlmMessage[],
  opts: LlmChatOptions,
  jsonMode: boolean,
  signal: AbortSignal,
): Promise<LlmChatResult> {
  if (signal.aborted) throw abortReason(signal);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders(config.providerId),
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (jsonMode) body.response_format = { type: 'json_object' };

  let resp: Response;
  try {
    resp = await fetchImpl(chatUrl(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw abortReason(signal);
    throw new LlmError('network', redact(`网络请求失败： ${(e as Error).message}`), undefined, true);
  }

  const raw = await resp.text();
  if (!resp.ok) {
    const snippet = redact(raw.slice(0, 300));
    if (resp.status === 401 || resp.status === 403) {
      throw new LlmError('auth', `API Key 无效或无权限（HTTP ${resp.status}）`, resp.status);
    }
    if (resp.status === 429) {
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      throw new LlmError('rateLimit', '请求过于频繁（HTTP 429）', resp.status, true, retryAfterMs ?? undefined);
    }
    if (resp.status >= 500) {
      throw new LlmError('server', `服务端错误（HTTP ${resp.status}）： ${snippet}`, resp.status, true);
    }
    // 400 等：jsonMode 不被支持时降级一次，其余直接抛
    if (jsonMode && looksLikeJsonModeRejection(raw)) {
      throw new LlmError('badRequest', 'response_format json_mode 不受支持', resp.status);
    }
    throw new LlmError('badRequest', `请求被拒绝（HTTP ${resp.status}）： ${snippet}`, resp.status);
  }

  return parseChatResponse(raw);
}

function looksLikeJsonModeRejection(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('response_format') ||
    lower.includes('json_object') ||
    lower.includes('json mode') ||
    lower.includes('json_mode')
  );
}

function parseChatResponse(raw: string): LlmChatResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmError('parse', redact(`响应不是 JSON： ${raw.slice(0, 200)}`));
  }
  const obj = parsed as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.length > 0) {
    return {
      text: content,
      usage: obj.usage
        ? { promptTokens: obj.usage.prompt_tokens, completionTokens: obj.usage.completion_tokens }
        : undefined,
    };
  }
  // 部分兼容端点返回分段 content（多模态骨架）；拼接文本段
  if (Array.isArray(content)) {
    const text = content.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join('');
    if (text) return { text };
  }
  throw new LlmError('parse', '响应里没有文本内容（choices[0].message.content 缺失）');
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof LlmError) return reason;
  return new LlmError('aborted', '请求已取消');
}

function rethrowIfAbort(e: unknown): void {
  if (e instanceof LlmError && (e.kind === 'aborted' || e.kind === 'timeout')) throw e;
  if ((e as Error)?.name === 'AbortError') throw new LlmError('aborted', '请求已取消');
}

/** 统一入口：构建 chat 函数后立即调用 */
export function createChat(config: LlmConfig): LlmChat {
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    throw new LlmError('badRequest', 'baseUrl 必须以 http(s):// 开头');
  }
  if (!config.model) throw new LlmError('badRequest', '缺少模型 ID');
  return (messages, opts = {}) => chatWith(config, messages, opts);
}

export async function chatWith(config: LlmConfig, messages: LlmMessage[], opts: LlmChatOptions = {}): Promise<LlmChatResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoffBase = opts.backoffBaseMs ?? 800;
  let jsonMode = !!opts.jsonMode;

  let attempt = 0;
  // jsonMode 降级也算一次消费，避免死循环：最多 1 次降级
  let jsonModeDropped = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { controller, cleanup } = combinedSignal(timeoutMs, opts.signal);
    try {
      return await requestOnce(config, messages, opts, jsonMode, controller.signal);
    } catch (e) {
      rethrowIfAbort(e);
      const err = e instanceof LlmError ? e : new LlmError('network', redact((e as Error).message), undefined, true);
      const dropJsonMode = err.kind === 'badRequest' && jsonMode && !jsonModeDropped && looksLikeJsonModeRejection(err.message);
      if (dropJsonMode) {
        jsonMode = false;
        jsonModeDropped = true;
        continue;
      }
      const canRetry = err.retryable && attempt < retries && !opts.signal?.aborted;
      if (!canRetry) throw err;
      attempt += 1;
      // 服务端明确给了 Retry-After 就照办（cap 30s 已在解析时做）；否则常规指数退避
      const wait = err.retryAfterMs ?? backoffBase * 2 ** (attempt - 1);
      await sleep(wait, opts.signal);
    } finally {
      cleanup();
    }
  }
}

// ---------- LLM 输出的 JSON 提取（前置校验第一步） ----------

export type JsonExtraction = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * 从模型回复中提取 JSON 对象/数组：
 * 1. 整体就是 JSON；2. 去 ```json 围栏；3. 扫描前若干个括号起点做平衡切片。
 * 起点设上限（实测：无上限时 24KB 恶劣回复要 765ms 平方级扫描；真 JSON
 * 几乎总在首个 { —— 围栏/全文候选早已覆盖其余情况），最坏退化为线性。
 */
export const EXTRACT_JSON_MAX_STARTS = 6;

export function extractJson(text: string): JsonExtraction {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const starts = scanBalancedStarts(trimmed).slice(0, EXTRACT_JSON_MAX_STARTS);
  for (const start of starts) {
    const slice = extractBalanced(trimmed, start);
    if (slice) candidates.push(slice);
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { ok: false, error: `回复中找不到合法 JSON： ${errors[0] ?? '无候选片段'}` };
}

function scanBalancedStarts(text: string): number[] {
  return [...text].reduce<number[]>((starts, ch, i) => {
    if (ch === '{' || ch === '[') starts.push(i);
    return starts;
  }, []);
}

function extractBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
