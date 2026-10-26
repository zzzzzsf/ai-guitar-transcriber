/**
 * AI Copilot 连接状态（BYOK）。
 *
 * 隐私原则（v4.1 §1.3）：API Key 只保存在本次会话内存的 ref 中（connect 写入、
 * disconnect 清空、getApiKey 供 llm/ 引擎发请求），刷新即清除，绝不写入
 * localStorage / sessionStorage。装壳后将整体改为主进程代理 + OS keychain
 * （Key 永不进入 webview），届时本 ref 链路退役。
 *
 * 模型能力要求：Copilot 全部功能只需要「文本输入 → 文本输出」的对话模型
 * （OpenAI 兼容 /chat/completions），不依赖多模态 / 函数调用 / 联网 —— 因此
 * 连接界面不做能力标记，任意文本对话大模型均可接入。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type CopilotProviderId =
  | 'deepseek'
  | 'zhipu'
  | 'qwen'
  | 'kimi'
  | 'openai'
  | 'gemini'
  | 'claude'
  | 'custom';

export type CopilotProviderInfo = {
  label: string;
  /** OpenAI 兼容 base URL（custom 由用户填写） */
  baseUrl: string;
  /** 常用模型快捷项（也可选“自定义模型 ID”手填）。核对自各厂商官方 API 文档，2026-10 */
  models: string[];
  keyPlaceholder: string;
  /** 厂商芯片下方的一行小注 */
  host: string;
};

export const COPILOT_PROVIDERS: Record<CopilotProviderId, CopilotProviderInfo> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyPlaceholder: 'sk-...',
    host: 'api.deepseek.com',
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    keyPlaceholder: 'id.secret 或 sk-...',
    host: 'open.bigmodel.cn',
  },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'],
    keyPlaceholder: 'sk-...',
    host: 'dashscope.aliyuncs.com',
  },
  kimi: {
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.6'],
    keyPlaceholder: 'sk-...',
    host: 'api.moonshot.cn',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'],
    keyPlaceholder: 'sk-...',
    host: 'api.openai.com',
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    keyPlaceholder: 'AIza...',
    host: 'Google AI Studio · OpenAI 兼容端点',
  },
  claude: {
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    keyPlaceholder: 'sk-ant-...',
    host: 'api.anthropic.com · OpenAI 兼容端点',
  },
  custom: {
    label: '自定义 API',
    baseUrl: '',
    models: [],
    keyPlaceholder: '服务要求时填写（本地 Ollama 等可留空）',
    host: '任意 OpenAI 兼容端点',
  },
};

/** 连接摘要（不含 Key —— Key 存在独立 ref，不参与任何渲染） */
export type CopilotConnection = {
  providerId: CopilotProviderId;
  label: string;
  baseUrl: string;
  model: string;
};

export type CopilotConnectInput = {
  providerId: CopilotProviderId;
  apiKey: string;
  /** custom 必填（OpenAI 兼容 base URL）；预设厂商使用注册表地址 */
  baseUrl?: string;
  /** 模型 ID；预设厂商缺省用注册表第一个 */
  model?: string;
};

type CopilotContextValue = {
  connected: boolean;
  connection: CopilotConnection | null;
  /** 校验连接信息并标记为已连接（Key 存入会话内存 ref，刷新即清除） */
  connect: (input: CopilotConnectInput) => { ok: boolean; error?: string };
  disconnect: () => void;
  /**
   * 取会话内存中的 API Key（llm/ 引擎发请求用）。
   * 只在内存中流动：不写入任何 storage、不出现在渲染输出；
   * 装壳后此路径整体替换为主进程代理（§1.3 终态，Key 永不进 webview）。
   */
  getApiKey: () => string | undefined;
};

const CopilotContext = createContext<CopilotContextValue | null>(null);

function validate(input: CopilotConnectInput): { connection: CopilotConnection } | { error: string } {
  const info = COPILOT_PROVIDERS[input.providerId];
  const key = input.apiKey.trim();
  if (input.providerId === 'custom') {
    const base = (input.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\//i.test(base)) {
      return { error: '请填写以 http(s):// 开头的接口地址（OpenAI 兼容）' };
    }
    const model = (input.model ?? '').trim();
    if (!model) return { error: '请填写模型 ID（如 qwen3.8-flash、gpt-6-luna）' };
    return { connection: { providerId: 'custom', label: info.label, baseUrl: base, model } };
  }
  if (key.length < 8) return { error: `${info.label} 的 API Key 格式不正确（长度不足）` };
  const model = (input.model ?? '').trim() || info.models[0];
  if (!model) return { error: '请填写模型 ID' };
  return { connection: { providerId: input.providerId, label: info.label, baseUrl: info.baseUrl, model } };
}

export function CopilotProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<CopilotConnection | null>(null);
  // Key 的会话内存：ref 不触发渲染、不进 devtools 的 state 树；断开/刷新即清除
  const keyRef = useRef<string>('');

  const connect = useCallback((input: CopilotConnectInput) => {
    const result = validate(input);
    if ('error' in result) return { ok: false as const, error: result.error };
    keyRef.current = input.apiKey.trim();
    setConnection(result.connection);
    return { ok: true as const };
  }, []);

  const disconnect = useCallback(() => {
    keyRef.current = '';
    setConnection(null);
  }, []);

  const getApiKey = useCallback(() => keyRef.current || undefined, []);

  const value = useMemo(
    () => ({ connected: connection !== null, connection, connect, disconnect, getApiKey }),
    [connection, connect, disconnect, getApiKey],
  );
  return <CopilotContext.Provider value={value}>{children}</CopilotContext.Provider>;
}

export function useCopilot(): CopilotContextValue {
  const ctx = useContext(CopilotContext);
  if (!ctx) throw new Error('useCopilot 必须在 <CopilotProvider> 内使用');
  return ctx;
}
