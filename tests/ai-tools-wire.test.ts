import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, streamApi } from '../apps/desktop/src/core/ai-providers';
import { defaultAiConfig, type AiConfig, type AiMessage } from '../apps/desktop/src/shared/ai';
import { STUDY_TOOLS } from '../apps/desktop/src/core/study-tools';
import { contextHistory } from '../apps/desktop/src/core/chat-context';
import { protocolKey } from '../apps/desktop/src/core/ai-wire';
import { chatInput } from '../apps/desktop/src/core/ai-wire';
const fetcher =
  (events: any[]): typeof fetch =>
  async () =>
    new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
const args = '{"path":"A.md","start_line":1,"line_count":20}';
const user = { role: 'user' as const, content: '按需读取 A.md' };
test('Multiple tool results remain consecutive before any returned images', () => {
  const wire = chatInput([
    {
      role: 'tool',
      callId: 'one',
      content: 'image result',
      images: [{ id: 'i', data: 'cGl4ZWxz', mime: 'image/png', label: '图' }],
    },
    { role: 'tool', callId: 'two', content: 'second result' },
  ]);
  assert.deepEqual(
    wire.map((m) => m.role),
    ['tool', 'tool', 'user'],
  );
  assert.equal(wire[1].tool_call_id, 'two');
});
async function turn(protocol: AiConfig['protocol'], events: any[]) {
  const c = {
    ...defaultAiConfig,
    protocol,
    preset: protocol,
    model: 'fixture',
    baseUrl: 'http://127.0.0.1:9999/v1',
  };
  const result = await streamApi(
    c,
    'key',
    [user],
    new AbortController().signal,
    () => {},
    () => {},
    { tools: STUDY_TOOLS, fetcher: fetcher(events), project: 'p' },
  );
  return { c, result };
}
test('Responses preserves encrypted reasoning and function-call IDs for stateless continuation', async () => {
  const items = [
    { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'opaque-reasoning' },
    {
      type: 'function_call',
      id: 'fc',
      call_id: 'call-1',
      name: 'read_note',
      arguments: args,
      status: 'completed',
    },
  ];
  const { c, result } = await turn('responses', [
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: items,
        usage: { input_tokens: 2000, output_tokens: 20, input_tokens_details: { cached_tokens: 1500 } },
      },
    },
  ]);
  assert.equal(result.calls[0].arguments, args);
  const request = apiRequest(
    c,
    'key',
    [user, result.message, { role: 'tool', callId: 'call-1', name: 'read_note', content: '实际正文' }],
    { tools: STUDY_TOOLS },
  );
  assert.deepEqual(request.body.input.slice(1, 3), items);
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.equal(request.body.input[3].call_id, 'call-1');
  assert.equal(result.usage.cached, 1500);
});
test('Chat tools assemble fragmented JSON/name and preserve reasoning_content across calls', async () => {
  const { c, result } = await turn('chat', [
    {
      choices: [
        {
          delta: {
            reasoning_content: 'opaque-thought',
            tool_calls: [
              { index: 0, id: 'call-c', function: { name: 'read_note', arguments: args.slice(0, 15) } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(15) } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ]);
  assert.equal(result.calls[0].arguments, args);
  const wire = apiRequest(
    c,
    'key',
    [user, result.message, { role: 'tool', callId: 'call-c', name: 'read_note', content: '正文' }],
    { tools: STUDY_TOOLS },
  ).body;
  assert.equal(wire.messages[1].reasoning_content, 'opaque-thought');
  assert.equal(wire.messages[2].tool_call_id, 'call-c');
  assert.equal(wire.parallel_tool_calls, false);
});
test('Claude retains thinking signatures and tool blocks and enables automatic prompt caching', async () => {
  const { c, result } = await turn('anthropic', [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-opaque' } },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tool-c', name: 'read_note', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
  const wire = apiRequest(
    c,
    'key',
    [user, result.message, { role: 'tool', callId: 'tool-c', name: 'read_note', content: '正文' }],
    { tools: STUDY_TOOLS },
  ).body;
  assert.equal(wire.messages[1].content[0].signature, 'signed-opaque');
  assert.equal(wire.messages[2].content[0].tool_use_id, 'tool-c');
  assert.deepEqual(wire.cache_control, { type: 'ephemeral' });
});
test('Gemini/Antigravity preserve exact thoughtSignature parts and response IDs with real inline images', async () => {
  for (const protocol of ['gemini', 'antigravity'] as const) {
    const part = {
      functionCall: { id: 'fn-1', name: 'read_note', args: JSON.parse(args) },
      thoughtSignature: 'signature-never-drop',
    };
    const payload = { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }] };
    const { c, result } = await turn(protocol, [
      protocol === 'antigravity' ? { response: payload } : payload,
    ]);
    const raw = apiRequest(
      c,
      'key',
      [
        user,
        result.message,
        {
          role: 'tool',
          callId: 'fn-1',
          name: 'read_note',
          content: '正文',
          images: [{ id: 'i', data: 'aW1hZ2U=', mime: 'image/png', label: '真实画面' }],
        },
      ],
      { tools: STUDY_TOOLS },
    ).body;
    const wire = protocol === 'antigravity' ? raw.request : raw;
    assert.deepEqual(wire.contents[1].parts, [part]);
    assert.equal(wire.contents[2].parts[0].functionResponse.id, 'fn-1');
    assert.equal(wire.contents[2].parts.at(-1).inlineData.data, 'aW1hZ2U=');
    assert.equal(wire.tools[0].functionDeclarations.length, 28);
  }
});
test('History replay is append-only across turns; model switches cannot reuse foreign opaque signatures', async () => {
  const { c, result } = await turn('chat', [
    { choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }] },
  ]);
  const messages: AiMessage[] = [
    { id: 'u', role: 'user', text: '问题', prompt: '问题\n冻结路径 A.md', status: 'complete' },
    {
      id: 'a',
      role: 'assistant',
      text: '界面中可能增加换行',
      status: 'complete',
      protocolKey: protocolKey(c),
      turns: [result.message],
    },
  ];
  const first = apiRequest(c, 'key', contextHistory(messages, null, protocolKey(c)), {
    tools: STUDY_TOOLS,
  }).body;
  messages.push({ id: 'u2', role: 'user', text: '继续', prompt: '继续\n本轮只读', status: 'complete' });
  const next = apiRequest(c, 'key', contextHistory(messages, null, protocolKey(c)), {
    tools: STUDY_TOOLS,
  }).body;
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(next.tools, first.tools);
  assert.equal(contextHistory(messages, null, 'other-model')[1].native, undefined);
});
