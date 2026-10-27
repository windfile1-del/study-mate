import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { VaultService } from '../apps/desktop/src/core/vault';
import { workspace } from './helpers';

test('创建和修改普通Markdown，保留BOM、CRLF并生成可恢复备份', async (t) => {
  const root = await workspace(t);
  const vaultRoot = path.join(root, 'vault');
  const vault = await VaultService.open(vaultRoot, path.join(root, 'state'));
  t.after(() => vault.close());
  await fs.writeFile(
    path.join(vaultRoot, '原有.md'),
    '\uFEFF---\r\ntitle: 学习\r\n---\r\n\r\n内容\r\n',
    'utf8',
  );
  const original = await vault.read('原有.md');
  const saved = await vault.write({
    path: original.path,
    content: original.content.replace('内容', '新内容').replace(/\r\n/g, '\n'),
    expectedVersion: original.version,
    operationId: 'edit',
  });
  assert.match(saved.content, /新内容/);
  assert.ok(saved.content.startsWith('\uFEFF'));
  assert.equal(saved.content.replace(/\r\n/g, '').includes('\n'), false);
  const backup = await fs.readFile(
    path.join(root, 'state/backups', vault.id, original.version + '.md'),
    'utf8',
  );
  assert.equal(backup, original.content);
});
test('外部编辑触发版本冲突，原文件不会被覆盖', async (t) => {
  const root = await workspace(t);
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  const document = await vault.write({
    path: 'note.md',
    content: '初始版本',
    expectedVersion: null,
    operationId: 'create',
  });
  await fs.writeFile(path.join(vault.root, 'note.md'), 'Obsidian 的修改', 'utf8');
  await assert.rejects(
    vault.write({
      path: 'note.md',
      content: '旧编辑器的修改',
      expectedVersion: document.version,
      operationId: 'update',
    }),
    { code: 'CONFLICT' },
  );
  assert.equal((await vault.read('note.md')).content, 'Obsidian 的修改');
});
test('创建操作幂等且跨进程恢复，同一操作ID不能改换载荷', async (t) => {
  const root = await workspace(t);
  const vaultRoot = path.join(root, 'vault');
  const state = path.join(root, 'state');
  const vault = await VaultService.open(vaultRoot, state);
  const input = {
    path: '课程/笔记.md',
    content: '# 一次创建',
    expectedVersion: null,
    operationId: 'idempotent',
  };
  const first = await vault.write(input);
  const second = await vault.write(input);
  assert.equal(first.version, second.version);
  await vault.close();
  const restored = await VaultService.open(vaultRoot, state);
  t.after(() => restored.close());
  assert.equal((await restored.write(input)).version, first.version);
  await assert.rejects(restored.write({ ...input, content: '不同内容' }), { code: 'OPERATION_REUSED' });
  await assert.rejects(restored.write({ ...input, operationId: 'another-create' }), { code: 'CONFLICT' });
});
test('阻止相对越界、绝对路径、Windows设备名和替代数据流', async (t) => {
  const root = await workspace(t);
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  for (const invalid of [
    '../outside.md',
    '..\\outside.md',
    'C:\\outside.md',
    '/outside.md',
    'NUL.md',
    'data.md:stream',
    '.obsidian/config.md',
  ]) {
    await assert.rejects(
      vault.write({ path: invalid, content: '不应写入', expectedVersion: null, operationId: invalid }),
      { code: 'PATH_DENIED' },
    );
  }
});
test('目录联接不能扩大知识库授权', async (t) => {
  const root = await workspace(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  await fs.symlink(
    outside,
    path.join(vault.root, 'redirect'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    vault.write({
      path: 'redirect/secret.md',
      content: '不应写入',
      expectedVersion: null,
      operationId: 'junction',
    }),
    { code: 'PATH_DENIED' },
  );
  assert.deepEqual(await fs.readdir(outside), []);
});
test('中文双字搜索可命中内容，外部文件变化会触发刷新', async (t) => {
  const root = await workspace(t);
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  await vault.write({
    path: '自动控制.md',
    content: '阻尼比决定振荡的衰减速度。',
    expectedVersion: null,
    operationId: 'control',
  });
  assert.equal((await vault.search('阻尼'))[0]?.path, '自动控制.md');
  await vault.watch();
  const changed = once(vault, 'changed', { signal: AbortSignal.timeout(5000) });
  await fs.writeFile(path.join(vault.root, '外部新增.md'), '# 由其他编辑器创建');
  await changed;
  assert.ok((await vault.list()).some((file) => file.path === '外部新增.md'));
});
