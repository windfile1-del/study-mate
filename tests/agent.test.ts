import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ToolBroker, AgentRuntime, type ToolScope } from '../apps/desktop/src/core/agent';
import { VaultService } from '../apps/desktop/src/core/vault';
import type { LearningContext } from '../apps/desktop/src/shared/contracts';
import { workspace, anchor } from './helpers';

async function setup(t: Parameters<typeof workspace>[0]) {
  const root = await workspace(t);
  let vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  const context: LearningContext = { anchor: anchor(), frames: [], subtitles: [], gaps: [], stale: false };
  const broker = new ToolBroker(
    () => vault,
    async (request) => {
      assert.equal(request.sourceId, context.anchor.sourceId);
      return context;
    },
  );
  const scope: ToolScope = Object.freeze({ anchor: context.anchor, vaultId: vault.id, allowWrite: false });
  return {
    broker,
    scope,
    context,
    vault,
    setVault: (value: VaultService) => {
      vault = value;
    },
  };
}
test('没有模型时明确返回未连接，不生成模拟回答', async (t) => {
  const { broker, context, scope } = await setup(t);
  await assert.rejects(
    new AgentRuntime(broker).run('解释课程', context, scope, new AbortController().signal),
    { code: 'NO_PROVIDER' },
  );
});
test('工具不提供shell或播放器控制，读取请求不能修改笔记', async (t) => {
  const { broker, scope } = await setup(t);
  const signal = new AbortController().signal;
  for (const name of ['shell', 'seek_video', 'delete_file'])
    await assert.rejects(broker.execute(name, {}, scope, signal), { code: 'TOOL_DENIED' });
  await assert.rejects(
    broker.execute('create_note', { path: 'note.md', content: 'x', operationId: 'x' }, scope, signal),
    { code: 'WRITE_NOT_AUTHORIZED' },
  );
});
test('被授权的Agent写入仍受知识库范围与版本控制', async (t) => {
  const { broker, scope, vault } = await setup(t);
  const writable = { ...scope, allowWrite: true };
  const signal = new AbortController().signal;
  await broker.execute(
    'create_note',
    { path: '课程笔记.md', content: '课程内容', operationId: 'save' },
    writable,
    signal,
  );
  assert.equal((await vault.read('课程笔记.md')).content, '课程内容');
  await assert.rejects(
    broker.execute(
      'create_note',
      { path: '../escape.md', content: 'x', operationId: 'escape' },
      writable,
      signal,
    ),
    { code: 'PATH_DENIED' },
  );
  await assert.rejects(
    broker.execute(
      'patch_note',
      { path: '课程笔记.md', content: '覆盖', expectedVersion: 'stale', operationId: 'patch' },
      writable,
      signal,
    ),
    { code: 'CONFLICT' },
  );
});
test('工具循环按冻结上下文执行并有步骤预算', async (t) => {
  const { broker, scope, context } = await setup(t);
  const agent = new AgentRuntime(broker, {
    name: 'test-fixture',
    async next(input) {
      assert.equal(input.context.anchor.sourceId, scope.anchor.sourceId);
      return input.toolResults.length
        ? { text: '基于冻结课程的回答' }
        : { toolCalls: [{ id: 'read', name: 'get_learning_context', input: {} }] };
    },
  });
  assert.equal(
    await agent.run('解释课程', context, scope, new AbortController().signal),
    '基于冻结课程的回答',
  );
  agent.setProvider({
    name: 'loop-fixture',
    async next() {
      return { toolCalls: [{ id: 'repeat', name: 'get_learning_context', input: {} }] };
    },
  });
  await assert.rejects(agent.run('循环', context, scope, new AbortController().signal, 2), {
    code: 'STEP_LIMIT',
  });
});
test('切换知识库后不能将旧请求的写权限带到新知识库', async (t) => {
  const setupValue = await setup(t);
  const second = await VaultService.open(
    path.join(path.dirname(setupValue.vault.root), 'second-vault'),
    path.join(path.dirname(setupValue.vault.root), 'second-state'),
  );
  await setupValue.vault.close();
  setupValue.setVault(second);
  await assert.rejects(
    setupValue.broker.execute(
      'create_note',
      { path: 'note.md', content: '旧请求', operationId: 'old' },
      { ...setupValue.scope, allowWrite: true },
      new AbortController().signal,
    ),
    { code: 'STALE_VAULT' },
  );
  assert.deepEqual(await second.list(), []);
});
