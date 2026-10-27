import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers';
import { VaultService } from '../apps/desktop/src/core/vault';
import { StudyTools, type StudyToolScope } from '../apps/desktop/src/core/study-tools';
import { randomUUID } from 'node:crypto';
const signal = new AbortController().signal;
test('Multiline exact replacement accepts read-style LF and preserves original CRLF', async (t) => {
  const f = await setup(t);
  const doc = await f.vault.write({
    path: 'A.md',
    content: '第一行\r\n第二行\r\n第三行\r\n',
    expectedVersion: f.doc.version,
    operationId: randomUUID(),
  });
  // Existing file was LF; create a separate CRLF document to exercise the actual on-disk convention.
  await fs.writeFile(path.join(f.vault.root, 'A.md'), '第一行\r\n第二行\r\n第三行\r\n');
  const read = await f.read();
  await f.call('replace_in_note', {
    path: 'A.md',
    old_text: '第一行\n第二行',
    new_text: '替换行\n第二行',
    expected_version: read.version,
    replace_all: false,
  });
  assert.equal((await f.vault.read('A.md')).content, '替换行\r\n第二行\r\n第三行\r\n');
});
test('Local image import copies selected files into the vault without modifying originals', async (t) => {
  const root = await workspace(t),
    original = path.join(root, 'chosen.png');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await fs.writeFile(original, bytes);
  const vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  const result = await vault.importImages([original, path.join(root, 'blocked.exe')]);
  assert.equal(result.paths.length, 1);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(await fs.readFile(original), bytes);
  assert.deepEqual(await fs.readFile(await vault.imagePath(result.paths[0])), bytes);
  assert.equal((await vault.importImages([original])).paths[0], result.paths[0]);
});
async function setup(t: Parameters<typeof workspace>[0]) {
  const root = await workspace(t),
    vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  const doc = await vault.write({
    path: 'A.md',
    content: '# 原笔记\n\n唯一片段\n重复\n重复\n',
    expectedVersion: null,
    operationId: randomUUID(),
  });
  const scope: StudyToolScope = {
    vaultId: vault.id,
    requestId: randomUUID(),
    allowWrite: true,
    dirtyPaths: [],
    currentVault: () => vault,
    context: async () => null,
    analyze: async () => {
      throw Error('no video');
    },
  };
  const tools = new StudyTools(scope);
  t.after(() => vault.close());
  const call = (name: string, args: any, id: string = randomUUID()) =>
    tools.execute({ id, name, arguments: JSON.stringify(args) }, signal);
  const read = async () =>
    JSON.parse((await call('read_note', { path: 'A.md', start_line: 1, line_count: 200 })).text);
  return { root, vault, doc, scope, call, read };
}
test('Study tools require reads and exact versions, reject ambiguous replace, save backups and deduplicate call IDs', async (t) => {
  const f = await setup(t);
  const edit = {
    path: 'A.md',
    expected_version: f.doc.version,
    old_text: '唯一片段',
    new_text: '修改完成 $1',
    replace_all: false,
  };
  await assert.rejects(f.call('replace_in_note', edit), /先调用/);
  await f.read();
  await assert.rejects(f.call('replace_in_note', { ...edit, old_text: '重复' }), /不唯一/);
  const result = await f.call('replace_in_note', edit, 'same-operation');
  assert.deepEqual(await f.call('replace_in_note', edit, 'same-operation'), result);
  await assert.rejects(f.call('replace_in_note', { ...edit, new_text: 'changed' }, 'same-operation'), /重复/);
  assert.match((await f.vault.read('A.md')).content, /修改完成 \$1/);
  assert.equal(
    await fs.readFile(path.join(f.root, 'state/backups', f.vault.id, f.doc.version + '.md'), 'utf8'),
    f.doc.content,
  );
  await f.read();
  await f.vault.write({
    path: 'A.md',
    content: '外部修改',
    expectedVersion: JSON.parse(result.text).version,
    operationId: randomUUID(),
  });
  await assert.rejects(
    f.call('replace_in_note', { ...edit, expected_version: JSON.parse(result.text).version }),
    /已变化/,
  );
});
test('Read-only, dirty drafts, vault switch, traversal, cancellation and unknown tool cannot write', async (t) => {
  const f = await setup(t);
  await f.read();
  const args = { path: 'A.md', content: 'overwrite', expected_version: f.doc.version };
  f.scope.allowWrite = false;
  await assert.rejects(f.call('save_note', args), /只读/);
  f.scope.allowWrite = true;
  f.scope.dirtyPaths = ['a.md'];
  await assert.rejects(f.call('save_note', args), /草稿/);
  f.scope.dirtyPaths = [];
  await assert.rejects(f.call('read_note', { path: '../A.md', start_line: 1, line_count: 20 }));
  await assert.rejects(f.call('shell', { command: 'anything' }), /允许列表/);
  await assert.rejects(
    new StudyTools({ ...f.scope, vaultId: 'other' }).execute(
      { id: 'x', name: 'list_notes', arguments: '{"directory":"","offset":0,"limit":10}' },
      signal,
    ),
    /已切换/,
  );
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(
    new StudyTools(f.scope).execute(
      { id: 'x', name: 'save_note', arguments: JSON.stringify(args) },
      stop.signal,
    ),
  );
  assert.equal((await f.vault.read('A.md')).content, f.doc.content);
});
test('Partial reads cannot authorize whole-file overwrite and large output remains bounded', async (t) => {
  const f = await setup(t);
  await f.call('read_note', { path: 'A.md', start_line: 1, line_count: 1 });
  await assert.rejects(
    f.call('save_note', { path: 'A.md', expected_version: f.doc.version, content: 'bad' }),
    /读完/,
  );
  const full = await f.read();
  assert.equal(full.next_line, null);
  await f.call('save_note', { path: 'A.md', expected_version: f.doc.version, content: '# 正确覆盖' });
  const fresh = await f.vault.write({
    path: 'long.md',
    content: '文'.repeat(20000),
    expectedVersion: null,
    operationId: randomUUID(),
  });
  const result = JSON.parse(
    (await f.call('read_note', { path: 'long.md', start_line: 1, line_count: 200 })).text,
  );
  assert.equal(result.lines[0].text.length, 16000);
  assert.equal(result.truncated, true);
  await assert.rejects(
    f.call('save_note', { path: 'long.md', expected_version: fresh.version, content: 'bad' }),
    /读完/,
  );
});
test('Video pixels use real returned frames and insert_image saves a vault attachment and relative Markdown link', async (t) => {
  const f = await setup(t);
  await f.read();
  const bytes = Buffer.from('RIFF....WEBPfixture');
  f.scope.analyze = async () => ({
    id: 'a',
    sourceId: 's',
    title: '视频',
    createdAt: new Date().toISOString(),
    duration: 10,
    width: 10,
    height: 10,
    frames: [
      {
        id: 'frame-1',
        timestamp: 1,
        width: 10,
        height: 10,
        data: 'data:image/webp;base64,' + bytes.toString('base64'),
        sceneCut: false,
      },
    ],
  });
  const analysis = await f.call('analyze_video', { start: 0, end: 2, frames: 1 });
  assert.equal(analysis.images?.[0].data, bytes.toString('base64'));
  await f.call('insert_image', {
    path: 'A.md',
    image: 'frame:frame-1',
    alt: '画面',
    after_text: '唯一片段',
    expected_version: f.doc.version,
  });
  assert.match((await f.vault.read('A.md')).content, /!\[画面\]\(attachments\/study-mate\/[a-f0-9]+\.webp\)/);
  assert.equal((await f.vault.listImages()).length, 1);
  const latest = await f.read();
  await assert.rejects(
    f.call('insert_image', {
      path: 'A.md',
      image: 'frame:unknown',
      alt: '',
      after_text: null,
      expected_version: latest.version,
    }),
    /不属于本轮/,
  );
});
