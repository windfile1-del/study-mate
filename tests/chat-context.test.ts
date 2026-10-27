import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compressionCut,
  compressionBatch,
  contextHistory,
  messageText,
  LEARNING_SYSTEM,
  sumUsage,
} from '../apps/desktop/src/core/chat-context';
import { emptyUsage } from '../apps/desktop/src/core/ai-providers';
import type { AiMessage } from '../apps/desktop/src/shared/ai';
const messages = Array.from({ length: 12 }, (_, i) => ({
  id: String(i),
  role: i % 2 ? 'assistant' : 'user',
  text: '重要的学习约束'.repeat(10),
  status: 'complete',
  at: new Date().toISOString(),
})) as AiMessage[];
test('Compression keeps three recent turns and batches whole pairs within budget', () => {
  assert.equal(compressionCut(messages, 0), 6);
  const first = compressionBatch(messages, 0, 6, 190);
  assert.equal(first.last, 2);
  assert.match(first.text, /assistant/);
  assert.throws(() => compressionBatch(messages, 0, 6, 1), /历史过长/);
  assert.equal(compressionCut(messages.slice(0, 4), 0), 0);
});
test('Path references remain metadata and summaries never grant nonexistent file tools', () => {
  const message: AiMessage = {
    ...messages[0],
    reference: { path: 'A.md', absolutePath: 'D:\\vault\\A.md', vaultId: 'vault-fixture' },
  };
  assert.match(messageText(message), /没有读取正文/);
  assert.match(messageText(message), /A.md/);
  assert.match(LEARNING_SYSTEM, /需要正文先调用 read_note/);
  const original = structuredClone(messages);
  const result = contextHistory(messages, {
    summary: '较早的目标',
    covered: 6,
    before: 1000,
    after: 600,
    model: 'test',
    at: new Date().toISOString(),
    usage: emptyUsage(),
  });
  assert.equal(result.length, 8);
  assert.match(result[0].content, /不是额外权限/);
  assert.deepEqual(messages, original);
  assert.equal(sumUsage(emptyUsage(), { ...emptyUsage(), input: 100 }).input, null);
});
