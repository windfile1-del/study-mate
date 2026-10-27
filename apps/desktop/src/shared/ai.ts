import { z } from 'zod';
import { documentContextSchema } from './documents';
export const aiConfigSchema = z
  .object({
    preset: z.string().max(50),
    protocol: z.enum(['responses', 'chat', 'anthropic', 'gemini', 'siwc', 'antigravity']),
    baseUrl: z.string().max(1000),
    model: z.string().max(200),
    effort: z.enum(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    contextSize: z.number().int().min(4096).max(2_000_000),
    maxOutput: z.number().int().min(256).max(64000),
    inputPrice: z.number().nonnegative().nullable(),
    cachedPrice: z.number().nonnegative().nullable(),
    outputPrice: z.number().nonnegative().nullable(),
    autoCompact: z.boolean().default(true),
    compactAt: z.number().min(0.5).max(0.9).default(0.8),
  })
  .strict()
  .refine((c) => c.maxOutput < c.contextSize / 2, '输出上限需小于上下文的一半');
export type AiConfig = z.infer<typeof aiConfigSchema>;
export interface AiUsage {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
  cost: number | null;
}
export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'complete' | 'streaming' | 'failed' | 'cancelled';
  usage?: AiUsage;
  model?: string;
  attachment?: string;
  reference?: { path: string; absolutePath: string; vaultId: string };
  error?: string;
  prompt?: string;
  turns?: AiPromptMessage[];
  protocolKey?: string;
  tools?: AiToolEvent[];
  requests?: number;
  lastInput?: number | null;
}
export interface AiImage {
  id: string;
  data: string;
  mime: string;
  label: string;
  source?:import('./recognition').OcrResult['source'];
}
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface AiPromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  callId?: string;
  name?: string;
  calls?: AiToolCall[];
  images?: AiImage[];
  native?: unknown;
}
export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface AiToolEvent {
  id: string;
  name: string;
  target: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  summary: string;
  startedAt: string;
  finishedAt?: string;
  changed?: string;
}
export interface AiModel {
  id: string;
  efforts: string[];
  contextSize?: number;
  displayName?: string;
}
export interface AiState {
  config: AiConfig;
  profiles: Record<string, AiConfig>;
  hasKey: boolean;
  messages: AiMessage[];
  busy: boolean;
  account: { label: string; plan: string; id?: string; authorized?: boolean } | null;
  accounts: { id: string; label: string; authorized: boolean }[];
  models: AiModel[];
  login: { url: string; code?: string; id: string } | null;
  notice: string;
  contextEstimate: number;
  omitted: number;
  compacting: boolean;
  memory: ContextMemory | null;
  compressionUsage: AiUsage | null;
}
export interface ContextMemory {
  summary: string;
  covered: number;
  before: number;
  after: number;
  model: string;
  at: string;
  usage: AiUsage | null;
  lastCoveredId?: string;
}
export const aiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }),
  z
    .object({
      action: z.literal('select'),
      preset: z.string().max(50).optional(),
      model: z.string().min(1).max(200).optional(),
      effort: z.enum(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    })
    .strict(),
  z.object({
    action: z.literal('configure'),
    config: aiConfigSchema,
    key: z.string().max(8192).optional(),
    forgetKey: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('send'),
    text: z.string().min(1).max(32000),
    note: z.object({ vaultId: z.string(), path: z.string().max(500) }).optional(),
    image:z.object({vaultId:z.string(),path:z.string().min(1).max(500)}).strict().optional(),
    document: documentContextSchema.optional(),
    course: z.boolean().optional(),
    allowWrite: z.boolean().default(false),
    dirtyPaths: z.array(z.string().max(500)).max(100).default([]),
  }),
  z.object({ action: z.literal('models') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('clear') }),
  z.object({
    action: z.literal('login'),
    device: z.boolean().optional(),
    newAccount: z.boolean().optional(),
  }),
  z.object({ action: z.literal('selectAccount'), id: z.string().max(200) }),
  z.object({ action: z.literal('compact') }),
  z.object({ action: z.literal('logout') }),
  z.object({ action: z.literal('cancelLogin') }),
  z.object({ action: z.literal('link'), url: z.string().max(1000) }),
]);
export type AiRequest = z.infer<typeof aiRequestSchema>;
export interface AiPreset {
  id: string;
  name: string;
  protocol: AiConfig['protocol'];
  url: string;
  model: string;
  portal: string;
  help: string;
}
export const AI_PRESETS: AiPreset[] = [
  {
    id: 'siwc',
    name: 'ChatGPT 订阅 · SIWC',
    protocol: 'siwc',
    url: 'https://api.openai.com/v1',
    model: '',
    portal: 'https://chatgpt.com',
    help: '以 Study Mate 名称进行官方 SIWC 授权，允许本应用使用你的 ChatGPT 订阅额度。无需 API Key，不使用 Codex 登录。实际模型、额度和组织策略以官方授权为准。',
  },
  {
    id: 'antigravity',
    name: 'Antigravity · 实验接入',
    protocol: 'antigravity',
    url: 'https://daily-cloudcode-pa.googleapis.com',
    model: '',
    portal: 'https://www.antigravity.google/terms',
    help: '参考 Harness-Mate 的 Google OAuth / Cloud Code Assist 适配。此为非官方兼容接入，Google 条款限制第三方使用，可能停用相关账户；Gemini 订阅不保证接口可用。',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    protocol: 'responses',
    url: 'https://api.openai.com/v1',
    model: '',
    portal: 'https://platform.openai.com/api-keys',
    help: '在 OpenAI 开发者平台创建 API Key，并开通 API 计费。ChatGPT 订阅与 API 余额分开。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek API',
    protocol: 'chat',
    url: 'https://api.deepseek.com',
    model: '',
    portal: 'https://platform.deepseek.com/api_keys',
    help: '在 DeepSeek 开放平台创建密钥并确认余额。请使用 API 模型名称，可先获取模型列表。',
  },
  {
    id: 'qwen',
    name: '通义千问 / 百炼',
    protocol: 'chat',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: '',
    portal: 'https://bailian.console.aliyun.com',
    help: '在阿里云百炼创建 API Key。中国内地与国际地域的地址和密钥需对应；可在高级设置修改地址。',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude API',
    protocol: 'anthropic',
    url: 'https://api.anthropic.com/v1',
    model: '',
    portal: 'https://platform.claude.com',
    help: '在 Claude 开发者平台创建 API Key 并开通余额；Claude 网页订阅不等于 API 额度。',
  },
  {
    id: 'gemini',
    name: 'Google Gemini API',
    protocol: 'gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    model: '',
    portal: 'https://aistudio.google.com/api-keys',
    help: '在 Google AI Studio 创建 API Key，确认所在地区可用及项目配额。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'chat',
    url: 'https://openrouter.ai/api/v1',
    model: '',
    portal: 'https://openrouter.ai/settings/keys',
    help: '创建 OpenRouter API Key；模型名称通常为组织/模型。实际价格与路由以平台为准。',
  },
  {
    id: 'custom',
    name: '自定义 / 本地兼容接口',
    protocol: 'chat',
    url: 'http://127.0.0.1:11434/v1',
    model: '',
    portal: '',
    help: '填写服务提供的基础地址与模型 ID。支持 OpenAI 兼容服务及已运行的本地服务；本地免密服务可留空密钥。',
  },
];
export const defaultAiConfig: AiConfig = {
  preset: 'siwc',
  protocol: 'siwc',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  effort: 'auto',
  contextSize: 32768,
  maxOutput: 4096,
  inputPrice: null,
  cachedPrice: null,
  outputPrice: null,
  autoCompact: true,
  compactAt: 0.8,
};
