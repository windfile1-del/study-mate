import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  apiRequest,
  emptyUsage,
  fitMessages,
  normalizeUsage,
  priceUsage,
  sse,
  streamApi,
} from '../apps/desktop/src/core/ai-providers';
import { defaultAiConfig, aiRequestSchema } from '../apps/desktop/src/shared/ai';
test('Usage distinguishes missing metrics, inclusive/exclusive cache counts and cumulative updates', () => {
  assert.equal(emptyUsage().cached, null);
  const a = normalizeUsage('anthropic', {
    input_tokens: 10,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 20,
    output_tokens: 1,
  });
  assert.equal(a.input, 60);
  assert.equal(a.total, 61);
  const b = normalizeUsage('anthropic', { output_tokens: 9 }, a);
  assert.equal(b.total, 69);
  assert.equal(b.cached, 30);
  const c = normalizeUsage('responses', {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens_details: { reasoning_tokens: 5 },
  });
  assert.equal(c.total, 120);
  assert.equal(c.reasoning, 5);
  assert.equal(
    priceUsage(c, { ...defaultAiConfig, inputPrice: 2, outputPrice: 8, cachedPrice: 1 }).cost,
    0.00032,
  );
  assert.equal(
    priceUsage({ ...c, cached: null }, { ...defaultAiConfig, inputPrice: 2, outputPrice: 8, cachedPrice: 1 })
      .cost,
    null,
  );
  assert.equal(
    normalizeUsage('gemini', {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 8,
      totalTokenCount: 23,
    }).total,
    23,
  );
});
test('Context removes whole turns, preserves system/latest material, refuses oversized questions', () => {
  const result = fitMessages(
    [
      { role: 'system', content: 'rules' },
      { role: 'user', content: '旧'.repeat(200) },
      { role: 'assistant', content: '答'.repeat(200) },
      { role: 'user', content: '新' },
    ],
    80,
  );
  assert.equal(result.omitted, 1);
  assert.deepEqual(
    result.messages.map((m) => m.role),
    ['system', 'user'],
  );
  assert.throws(() =>
    fitMessages(
      [
        { role: 'system', content: 'r' },
        { role: 'user', content: '大'.repeat(200) },
      ],
      80,
    ),
  );
  assert.equal(
    aiRequestSchema.safeParse({
      action: 'configure',
      config: { ...defaultAiConfig, contextSize: 4096, maxOutput: 4096 },
    }).success,
    false,
  );
});
test('Provider adapters keep credentials in headers and map reasoning natively', () => {
  const messages = [{ role: 'user' as const, content: '学习' }];
  const a = apiRequest(
    {
      ...defaultAiConfig,
      protocol: 'gemini',
      baseUrl: 'https://example.com/v1beta',
      model: 'gemini',
      effort: 'high',
    },
    'secret',
    messages,
  );
  assert.equal(a.headers['x-goog-api-key'], 'secret');
  assert.ok(!a.url.includes('secret'));
  assert.equal(a.body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  const b = apiRequest(
    {
      ...defaultAiConfig,
      protocol: 'anthropic',
      baseUrl: 'https://example.com/v1',
      model: 'claude',
      effort: 'high',
    },
    'secret',
    messages,
  );
  assert.equal(b.body.thinking.type, 'adaptive');
  assert.equal(b.headers.Authorization, undefined);
  assert.throws(() =>
    apiRequest(
      { ...defaultAiConfig, protocol: 'chat', baseUrl: 'http://external.example' },
      'secret',
      messages,
    ),
  );
});
test('SSE handles CRLF, split UTF-8, comments and multiple events', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"text":"中文"}\r\n\r\ndata: [DONE]\n\n');
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    }),
  );
  const result = [];
  for await (const e of sse(response)) result.push(e);
  assert.deepEqual(result, [{ text: '中文' }, { type: 'stream.done' }]);
});
test('Real HTTP streaming covers four protocols, early EOF, cancellation and auth failure', async () => {
  let mode = 'chat';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    if (mode !== 'gemini' && parsed.model !== 'fixture') {
      res.writeHead(400).end();
      return;
    }
    if (mode === 'unauthorized') {
      res.writeHead(401).end('private response must not surface');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (e: any) => res.write('data: ' + JSON.stringify(e) + '\n\n');
    if (mode === 'chat') {
      send({ choices: [{ delta: { content: '你好' } }] });
      send({
        choices: [{ finish_reason: 'stop', delta: {} }],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
      });
    }
    if (mode === 'responses') {
      send({ type: 'response.output_text.delta', delta: '你好' });
      send({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
        },
      });
    }
    if (mode === 'anthropic') {
      send({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      });
      send({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
      send({ type: 'message_stop' });
    }
    if (mode === 'gemini') {
      send({
        candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
      });
    }
    if (mode === 'eof') send({ choices: [{ delta: { content: '半句' } }] });
    if (mode === 'cancel') {
      send({ choices: [{ delta: { content: '半句' } }] });
      req.on('close', () => res.end());
      return;
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
      mode = protocol;
      let text = '',
        usage = emptyUsage();
      await streamApi(
        { ...defaultAiConfig, protocol, model: 'fixture', baseUrl },
        'fixture',
        [],
        new AbortController().signal,
        (t) => (text += t),
        (u) => (usage = u),
      );
      assert.equal(text, '你好');
      assert.equal(usage.total, 15);
    }
    mode = 'eof';
    await assert.rejects(
      streamApi(
        { ...defaultAiConfig, protocol: 'chat', model: 'fixture', baseUrl },
        '',
        [],
        new AbortController().signal,
        () => {},
        () => {},
      ),
      /提前结束/,
    );
    mode = 'unauthorized';
    await assert.rejects(
      streamApi(
        { ...defaultAiConfig, protocol: 'chat', model: 'fixture', baseUrl },
        '',
        [],
        new AbortController().signal,
        () => {},
        () => {},
      ),
      /密钥无效/,
    );
    mode = 'cancel';
    const controller = new AbortController();
    await assert.rejects(
      streamApi(
        { ...defaultAiConfig, protocol: 'chat', model: 'fixture', baseUrl },
        '',
        [],
        controller.signal,
        () => controller.abort(),
        () => {},
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
