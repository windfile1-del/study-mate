import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultService } from '../apps/desktop/src/core/vault';
import { SourceRegistry } from '../apps/desktop/src/core/sources';
import { MediaStore } from '../apps/desktop/src/core/media-store';
import { workspace } from './helpers';

test('导入外部UTF-8 Markdown，同名自动副本，不修改原件；部分失败不丢成功结果', async (t) => {
  const root = await workspace(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const original = path.join(outside, '课程.md');
  await fs.writeFile(original, '\uFEFF# 中文\r\n\r\n课程内容\r\n');
  const invalid = path.join(outside, '旧编码.md');
  await fs.writeFile(invalid, Buffer.from([0xff, 0xfe, 0x00]));
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  const first = await vault.importFiles([original, invalid]);
  assert.deepEqual(first.paths, ['课程.md']);
  assert.equal(first.errors.length, 1);
  const second = await vault.importFiles([original]);
  assert.deepEqual(second.paths, ['课程 (2).md']);
  assert.equal((await vault.read(first.paths[0])).content, await fs.readFile(original, 'utf8'));
  assert.deepEqual((await vault.importFiles([path.join(vault.root, '课程.md')])).paths, ['课程.md']);
  assert.deepEqual(new Set(await fs.readdir(outside)), new Set(['旧编码.md', '课程.md']));
});

test('跨卷EXDEV路径使用D盘暂存和备份，创建不覆盖已有文件', async (t) => {
  const root = await workspace(t);
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  const originalLink = fs.link.bind(fs);
  const originalRename = fs.rename.bind(fs);
  t.mock.method(fs, 'link', async (from: string, to: string) => {
    if (String(to).endsWith('.md')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    return originalLink(from, to);
  });
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (String(to).endsWith('.md')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    return originalRename(from, to);
  });
  const created = await vault.write({
    path: '外部盘.md',
    content: '原内容',
    expectedVersion: null,
    operationId: 'new',
  });
  await vault.write({
    path: created.path,
    content: '新内容',
    expectedVersion: created.version,
    operationId: 'update',
  });
  assert.equal(
    await fs.readFile(path.join(root, 'state', 'backups', vault.id, created.version + '.md'), 'utf8'),
    '原内容',
  );
  assert.equal((await vault.read(created.path)).content, '新内容');
  assert.deepEqual(await fs.readdir(path.join(root, 'state/staging')), []);
  await assert.rejects(
    vault.write({ path: created.path, content: '不能覆盖', expectedVersion: null, operationId: 'collision' }),
    { code: 'CONFLICT' },
  );
});

test('本地视频以文件版本隔离身份，旧来源回调不能串入新视频', async (t) => {
  const root = await workspace(t);
  const registry = new SourceRegistry(path.join(root, 'sources.json'));
  const first = registry.bindLocal(path.join(root, '中文 视频.mp4'), '100:1');
  registry.accepts(first, first.url, 1);
  const second = registry.bindLocal(path.join(root, '中文 视频.mp4'), '101:2');
  assert.notEqual(first.sourceId, second.sourceId);
  assert.throws(() => registry.accepts(first, first.url, 2), { code: 'STALE_SOURCE' });
  assert.throws(() => registry.accepts(second, first.url, 1), { code: 'SOURCE_MISMATCH' });
  await registry.flush();
});

test('原生解码画面持久化后只按来源、时间范围和证据截止时间读取', async (t) => {
  const root = await workspace(t);
  const store = new MediaStore(root);
  const before = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.save({
    id: 'job',
    sourceId: 'source',
    title: '课程',
    duration: 100,
    width: 640,
    height: 360,
    createdAt: new Date().toISOString(),
    frames: [10, 50, 95].map((timestamp) => ({
      id: String(timestamp),
      timestamp,
      width: 640,
      height: 360,
      data: 'data:image/webp;base64,' + Buffer.from('fixture').toString('base64'),
      sceneCut: false,
    })),
  });
  assert.deepEqual(await store.nearby('source', 100, before), []);
  assert.deepEqual(await store.nearby('other', 100, new Date().toISOString()), []);
  assert.deepEqual(
    (await store.nearby('source', 94, new Date().toISOString())).map((f) => f.timestamp),
    [10, 50],
  );
});
