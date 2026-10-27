import type { AiConfig, AiUsage, AiPromptMessage, AiToolCall, AiToolDefinition } from '../shared/ai';
import { responsesInput, chatInput, claudeInput, geminiInput, toolWire, promptCharacters } from './ai-wire';
import { ANTIGRAVITY_UA, RESOURCE } from './subscription-auth';
import { createHash, randomUUID } from 'node:crypto';
export type PromptMessage = AiPromptMessage;
export interface ProviderResult {
  message: PromptMessage;
  calls: AiToolCall[];
  usage: AiUsage;
}
export const emptyUsage = (): AiUsage => ({
  input: null,
  output: null,
  cached: null,
  cacheWrite: null,
  reasoning: null,
  total: null,
  cost: null,
});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
export function normalizeUsage(protocol: string, u: any, previous = emptyUsage()): AiUsage {
  const next = { ...previous };
  const assign = (k: keyof AiUsage, v: unknown) => {
    const n = num(v);
    if (n !== null) next[k] = n;
  };
  if (protocol === 'anthropic') {
    // Anthropic input_tokens excludes cache reads and cache writes.
    if (num(u.input_tokens) !== null)
      next.input =
        u.input_tokens + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
    assign('cached', u.cache_read_input_tokens);
    assign('cacheWrite', u.cache_creation_input_tokens);
    assign('output', u.output_tokens);
  } else if (protocol === 'gemini' || protocol === 'antigravity') {
    assign('input', u.promptTokenCount);
    assign('output', u.candidatesTokenCount);
    assign('cached', u.cachedContentTokenCount);
    assign('reasoning', u.thoughtsTokenCount);
    assign('total', u.totalTokenCount);
  } else {
    assign('input', u.input_tokens ?? u.prompt_tokens ?? u.inputTokens);
    assign('output', u.output_tokens ?? u.completion_tokens ?? u.outputTokens);
    assign(
      'cached',
      u.input_tokens_details?.cached_tokens ??
        u.prompt_tokens_details?.cached_tokens ??
        u.prompt_cache_hit_tokens ??
        u.cachedInputTokens,
    );
    assign('cacheWrite', u.cacheWriteInputTokens);
    assign(
      'reasoning',
      u.output_tokens_details?.reasoning_tokens ??
        u.completion_tokens_details?.reasoning_tokens ??
        u.reasoningOutputTokens,
    );
    assign('total', u.total_tokens ?? u.totalTokens);
  }
  if (
    num(u.total_tokens ?? u.totalTokens ?? u.totalTokenCount) === null &&
    next.input !== null &&
    next.output !== null
  )
    next.total =
      next.input + next.output + (['gemini', 'antigravity'].includes(protocol) ? (next.reasoning ?? 0) : 0);
  return next;
}
export function priceUsage(u: AiUsage, c: AiConfig): AiUsage {
  // Explicit prices in USD / million tokens. Unknown cache rates/write costs stay unknown.
  if (
    c.inputPrice === null ||
    c.outputPrice === null ||
    u.input === null ||
    u.output === null ||
    u.cached === null ||
    (u.cacheWrite ?? 0) > 0 ||
    (u.cached > 0 && c.cachedPrice === null)
  )
    return { ...u, cost: null };
  return {
    ...u,
    cost:
      ((u.input - u.cached) * c.inputPrice +
        u.cached * (c.cachedPrice ?? 0) +
        (u.output + (c.protocol === 'gemini' ? (u.reasoning ?? 0) : 0)) * c.outputPrice) /
      1e6,
  };
}
export function endpoint(base: string): URL {
  const u = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(u.protocol === 'https:' || (u.protocol === 'http:' && local))
  )
    throw new Error('接口地址必须使用 HTTPS；本机服务可使用 HTTP。请填写不含密钥、查询参数的基础地址。');
  return u;
}
export function apiRequest(
  c: AiConfig,
  key: string,
  messages: PromptMessage[],
  options?: { tools?: AiToolDefinition[] },
) {
  endpoint(c.baseUrl);
  const base = c.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (key) headers.Authorization = 'Bearer ' + key;
  let url = base + '/chat/completions',
    body: any = {
      model: c.model,
      messages: chatInput(messages),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: c.maxOutput,
    };
  if (c.protocol === 'responses' || c.protocol === 'siwc') {
    if (c.protocol === 'siwc') url = RESOURCE + '/responses';
    if (c.protocol !== 'siwc') url = base + '/responses';
    body = {
      model: c.model,
      input: responsesInput(messages),
      stream: true,
      max_output_tokens: c.maxOutput,
      store: false,
    };
    if (options?.tools?.length) body.include = ['reasoning.encrypted_content'];
    if (c.effort !== 'auto') body.reasoning = { effort: c.effort };
  } else if (c.protocol === 'anthropic') {
    delete headers.Authorization;
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    url = base + '/messages';
    body = {
      model: c.model,
      system: messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n'),
      messages: claudeInput(messages),
      max_tokens: c.maxOutput,
      stream: true,
    };
    if (c.effort !== 'auto') {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: c.effort };
    }
  } else if (c.protocol === 'gemini' || c.protocol === 'antigravity') {
    delete headers.Authorization;
    headers['x-goog-api-key'] = key;
    url =
      base +
      '/models/' +
      encodeURIComponent(c.model.replace(/^models\//, '')) +
      ':streamGenerateContent?alt=sse';
    body = {
      systemInstruction: {
        parts: [
          {
            text: messages
              .filter((m) => m.role === 'system')
              .map((m) => m.content)
              .join('\n'),
          },
        ],
      },
      contents: geminiInput(messages),
      generationConfig: { maxOutputTokens: c.maxOutput },
    };
    if (c.effort !== 'auto') body.generationConfig.thinkingConfig = { thinkingLevel: c.effort };
    if (c.protocol === 'antigravity') {
      delete headers['x-goog-api-key'];
      headers.Authorization = 'Bearer ' + key;
      headers['User-Agent'] = ANTIGRAVITY_UA;
      url = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
      if (/-(low|medium|high)$/.test(c.model)) delete body.generationConfig.thinkingConfig;
      body = {
        model: c.model,
        userAgent: 'antigravity',
        requestType: 'agent',
        requestId: 'agent-' + randomUUID(),
        request: {
          ...body,
          sessionId:
            '-' +
            (createHash('sha256')
              .update(messages.find((m) => m.role === 'user')?.content || 'Study Mate')
              .digest()
              .readBigUInt64BE() %
              9223372036854775807n),
        },
      };
    }
  } else {
    if (c.preset !== 'openai') {
      delete body.max_completion_tokens;
      body.max_tokens = c.maxOutput;
    }
    if (c.effort !== 'auto') body.reasoning_effort = c.effort;
    if (c.preset === 'deepseek' && c.effort !== 'auto')
      body.thinking = { type: c.effort === 'none' ? 'disabled' : 'enabled' };
  }
  if (options?.tools?.length) {
    const target = c.protocol === 'antigravity' ? body.request : body;
    target.tools = toolWire(c.protocol, options.tools);
    if (['responses', 'siwc', 'chat'].includes(c.protocol)) target.parallel_tool_calls = false;
    if (c.protocol === 'anthropic') {
      // Automatic caching moves the breakpoint forward without rewriting old message blocks.
      target.cache_control = { type: 'ephemeral' };
    }
  }
  return { url, headers, body };
}
export async function* sse(response: Response): AsyncGenerator<any> {
  if (!response.body) throw new Error('服务未返回响应流');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    done = false;
  try {
    while (!done) {
      const part = await reader.read();
      done = part.done;
      buffer += decoder.decode(part.value, { stream: !done });
      if (buffer.length > 4_000_000) throw new Error('服务响应过大');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data === '[DONE]') {
          yield { type: 'stream.done' };
          continue;
        }
        if (data) yield JSON.parse(data);
      }
    }
    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  } finally {
    reader.releaseLock();
  }
}
export async function streamApi(
  c: AiConfig,
  key: string,
  messages: PromptMessage[],
  signal: AbortSignal,
  onText: (text: string) => void,
  onUsage: (u: AiUsage) => void,
  session?: { project?: string; fetcher?: typeof fetch; tools?: AiToolDefinition[] },
): Promise<ProviderResult> {
  const req = apiRequest(c, key, messages, session);
  if (c.protocol === 'antigravity') {
    if (!session?.project) throw Error('缺少 Cloud Code Assist 项目，请重新登录');
    req.body.project = session.project;
  }
  const response = await (session?.fetcher || fetch)(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401
        ? ['siwc', 'antigravity'].includes(c.protocol)
          ? '订阅登录已过期或无效，请重新授权。'
          : '密钥无效或已过期，请检查接入设置。'
        : response.status === 429
          ? '服务限流或余额/套餐额度不足，请在服务商平台确认。'
          : `模型服务返回 HTTP ${response.status}，请检查模型权限、参数与接口地址。`,
    );
  }
  let usage = emptyUsage(),
    complete = false,
    finish: string | null = null;
  let text = '',
    reasoning = '';
  const calls: AiToolCall[] = [],
    responseItems = new Map<number, any>(),
    blocks = new Map<number, any>(),
    chatCalls = new Map<number, any>(),
    geminiParts: any[] = [];
  const emitText = (s: string) => {
    text += s;
    onText(s);
  };
  for await (const e of sse(response)) {
    if (e.error || e.type === 'error' || e.type === 'response.failed') {
      const code = e.error?.code || e.response?.error?.code || e.code;
      const notices: Record<string, string> = {
        subscription_sharing_user_not_eligible:
          '当前账户不具备订阅共享资格，请在官方账户页面确认套餐和组织权限。',
        subscription_sharing_usage_limit_exceeded: '已达到当前订阅使用限制，请在官方用量页面确认额度与限制。',
        subscription_sharing_usage_unavailable: '订阅用量服务暂不可用，请稍后重试。',
      };
      throw new Error(notices[code] || '模型服务生成失败，请检查账号权限或重试。');
    }
    if (c.protocol === 'responses' || c.protocol === 'siwc') {
      if (e.type === 'response.output_text.delta') emitText(e.delta || '');
      if (e.type === 'response.output_item.done') responseItems.set(e.output_index, e.item);
      if (e.response?.usage) {
        usage = normalizeUsage(c.protocol, e.response.usage, usage);
        onUsage(priceUsage(usage, c));
      }
      if (e.type === 'response.completed') {
        if (e.response?.status && e.response.status !== 'completed') throw Error('模型未正常完成回答');
        complete = true;
        if (e.response?.output) {
          responseItems.clear();
          e.response.output.forEach((item: any, i: number) => responseItems.set(i, item));
        }
      }
      if (e.type === 'response.incomplete')
        throw new Error('回答未完成：可能达到输出或推理上限，可增加输出上限后重试。');
    } else if (c.protocol === 'anthropic') {
      if (e.type === 'content_block_start') {
        const block = structuredClone(e.content_block);
        blocks.set(e.index, block);
        if (block.type === 'text' && block.text) emitText(block.text);
      }
      if (e.delta?.type === 'text_delta') {
        emitText(e.delta.text || '');
        const block = blocks.get(e.index);
        if (block) block.text = (block.text || '') + e.delta.text;
      }
      if (e.delta?.type === 'input_json_delta') {
        const block = blocks.get(e.index);
        if (block) block._json = (block._json || '') + e.delta.partial_json;
      }
      if (e.delta?.type === 'thinking_delta') {
        const block = blocks.get(e.index);
        if (block) block.thinking = (block.thinking || '') + e.delta.thinking;
      }
      if (e.delta?.type === 'signature_delta') {
        const block = blocks.get(e.index);
        if (block) block.signature = (block.signature || '') + e.delta.signature;
      }
      const u = e.message?.usage || e.usage;
      if (u) {
        usage = normalizeUsage(c.protocol, u, usage);
        onUsage(priceUsage(usage, c));
      }
      if (e.delta?.stop_reason) finish = e.delta.stop_reason;
      if (e.type === 'message_stop') complete = true;
    } else if (c.protocol === 'gemini' || c.protocol === 'antigravity') {
      const data = c.protocol === 'antigravity' ? e.response || e : e;
      for (const p of data.candidates?.[0]?.content?.parts || []) {
        geminiParts.push(structuredClone(p));
        if (p.text && !p.thought) emitText(p.text);
      }
      if (data.usageMetadata) {
        usage = normalizeUsage(c.protocol, data.usageMetadata, usage);
        onUsage(priceUsage(usage, c));
      }
      if (data.candidates?.[0]?.finishReason) {
        finish = data.candidates[0].finishReason;
        complete = true;
      }
      if (data.promptFeedback?.blockReason) throw new Error('请求被服务商拦截，未生成回答。');
    } else {
      const choice = e.choices?.[0];
      if (choice?.delta?.content) emitText(choice.delta.content);
      if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
      for (const call of choice?.delta?.tool_calls || []) {
        const previous = chatCalls.get(call.index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (call.id) previous.id = call.id;
        if (call.function?.name) previous.function.name += call.function.name;
        if (call.function?.arguments) previous.function.arguments += call.function.arguments;
        chatCalls.set(call.index, previous);
      }
      if (e.usage) {
        usage = normalizeUsage(c.protocol, e.usage, usage);
        onUsage(priceUsage(usage, c));
      }
      if (choice?.finish_reason) {
        finish = choice.finish_reason;
        complete = true;
      }
    }
  }
  if (!complete) throw new Error('连接提前结束，回答可能不完整；已保留收到的内容。');
  if (['length', 'max_tokens', 'MAX_TOKENS'].includes(finish || ''))
    throw new Error('回答达到输出上限；已保留内容，可调高输出上限后继续提问。');
  if (finish && !['stop', 'end_turn', 'stop_sequence', 'STOP', 'tool_calls', 'tool_use'].includes(finish))
    throw new Error('模型未正常完成回答：' + finish);
  let native: unknown;
  if (c.protocol === 'responses' || c.protocol === 'siwc') {
    native = [...responseItems.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    for (const item of native as any[])
      if (item.type === 'function_call')
        calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    if (!(native as any[]).length) native = undefined;
  } else if (c.protocol === 'anthropic') {
    const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    for (const block of content)
      if (block.type === 'tool_use') {
        if (block._json) block.input = JSON.parse(block._json);
        delete block._json;
        calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      }
    native = content.length ? content : undefined;
  } else if (c.protocol === 'gemini' || c.protocol === 'antigravity') {
    native = geminiParts.length ? { role: 'model', parts: geminiParts } : undefined;
    for (const part of geminiParts)
      if (part.functionCall)
        calls.push({
          id: part.functionCall.id || 'local-' + randomUUID(),
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        });
  } else {
    const ordered = [...chatCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    for (const item of ordered)
      calls.push({ id: item.id, name: item.function.name, arguments: item.function.arguments });
    native = {
      role: 'assistant',
      content: text || null,
      ...(ordered.length ? { tool_calls: ordered } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    };
  }
  if (calls.length > 8 || calls.some((call) => !call.id || !call.name || call.arguments.length > 180000))
    throw Error('模型返回无效或过多工具调用。');
  return {
    message: {
      role: 'assistant',
      content: text,
      ...(native ? { native } : {}),
      ...(calls.length ? { calls } : {}),
    },
    calls,
    usage: priceUsage(usage, c),
  };
}
export const estimateTokens = (text: string) =>
  Math.ceil([...text].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 1 : 0.28), 0));
export const messageTokens = (m: PromptMessage) =>
  estimateTokens(promptCharacters(m)) + (m.images?.length || 0) * 1500 + 8;
export function fitMessages(messages: PromptMessage[], budget: number) {
  const kept = [...messages];
  let omitted = 0;
  while (kept.length > 2 && kept.reduce((n, m) => n + messageTokens(m), 0) > budget) {
    // Remove complete user/assistant pairs, preserving system and newest question.
    kept.splice(1, kept[2]?.role === 'assistant' ? 2 : 1);
    omitted++;
  }
  const estimate = kept.reduce((n, m) => n + messageTokens(m), 0);
  if (estimate > budget)
    throw new Error('当前问题或附加笔记超过上下文预算，请选择更短内容或增加上下文大小。');
  return { messages: kept, estimate, omitted };
}
