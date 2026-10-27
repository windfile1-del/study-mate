import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TaskManager } from '../apps/desktop/src/core/tasks';
import { atomicJson } from '../apps/desktop/src/core/storage';
import { workspace, deferred } from './helpers';

test('队列遵守并发上限，被取消的等待任务不会执行', async (t) => {
  const root = await workspace(t);
  const manager = new TaskManager(path.join(root, 'tasks.json'), 1);
  await manager.initialize();
  t.after(() => manager.close());
  const gate = deferred<string>();
  let secondRan = false;
  const first = manager.submit('第一项', () => gate.promise);
  const second = manager.submit('第二项', async () => {
    secondRan = true;
    return 'second';
  });
  assert.equal(manager.list().find((t) => t.id === first.id)?.status, 'running');
  assert.equal(manager.list().find((t) => t.id === second.id)?.status, 'queued');
  manager.cancel(second.id);
  await assert.rejects(second.done, { code: 'CANCELLED' });
  gate.resolve('done');
  assert.equal(await first.done, 'done');
  assert.equal(secondRan, false);
});
test('运行任务收到AbortSignal，取消后不被标记为成功', async (t) => {
  const root = await workspace(t);
  const manager = new TaskManager(path.join(root, 'tasks.json'));
  await manager.initialize();
  t.after(() => manager.close());
  let sawAbort = false;
  const task = manager.submit(
    '可取消任务',
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            reject(new Error('cancel'));
          },
          { once: true },
        );
      }),
  );
  manager.cancel(task.id);
  await assert.rejects(task.done);
  assert.equal(sawAbort, true);
  assert.equal(manager.list()[0].status, 'cancelled');
});
test('任务失败可见且不阻塞后续任务', async (t) => {
  const root = await workspace(t);
  const manager = new TaskManager(path.join(root, 'tasks.json'), 1);
  await manager.initialize();
  t.after(() => manager.close());
  const failed = manager.submit('失败任务', async () => {
    throw new Error('示例错误');
  });
  const next = manager.submit('后续任务', async () => 42);
  await assert.rejects(failed.done, /示例错误/);
  assert.equal(await next.done, 42);
  assert.equal(manager.list().find((t) => t.id === failed.id)?.status, 'failed');
});
test('不响应取消的计算Promise不会阻塞逻辑队列和应用关闭', async (t) => {
  const root = await workspace(t);
  const manager = new TaskManager(path.join(root, 'tasks.json'), 1);
  await manager.initialize();
  const never = manager.submit('未响应任务', () => new Promise(() => {}));
  const next = manager.submit('后续任务', async () => '继续');
  manager.cancel(never.id);
  await assert.rejects(never.done, { code: 'CANCELLED' });
  assert.equal(await next.done, '继续');
  await manager.close();
});
test('重启时未完成任务标记interrupted，不重放写操作', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'tasks.json');
  await atomicJson(file, [
    { id: 'old-task', label: '旧写入', status: 'running', createdAt: new Date().toISOString() },
  ]);
  const manager = new TaskManager(file);
  await manager.initialize();
  t.after(() => manager.close());
  assert.equal(manager.list()[0].status, 'interrupted');
  assert.match(manager.list()[0].error!, /未自动重放/);
});
