import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { workspace } from './helpers';
import { AnnotationStore } from '../apps/desktop/src/core/annotations';
import type { DocumentInfo } from '../apps/desktop/src/shared/documents';
import { annotationRequest } from '../apps/desktop/src/shared/annotations';
import { textOnlyHistory } from '../apps/desktop/src/core/vision';
import { panelRequest } from '../apps/desktop/src/shared/panels';
test('批注按文档和页码持久化，版本冲突保护保留原记录', async (t) => {
  const root = await workspace(t),
    document: DocumentInfo = {
      id: 'doc-' + 'a'.repeat(24),
      revision: 'b'.repeat(64),
      kind: 'pdf',
      pages: 3,
      title: '课件',
      outline: [],
      locked: false,
      warning: '',
      lastPage: 1,
      size: 1,
      createdAt: new Date().toISOString(),
    },
    store = new AnnotationStore(root);
  t.after(() => store.close());
  const request = { id: document.id, page: 2, revision: document.revision };
  const first = await store.request({ action: 'get', ...request }, document);
  assert.equal(first.version, 0);
  const strokes = [
    {
      id: 'one',
      tool: 'line',
      color: '#0f766e',
      width: 0.003,
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.7, y: 0.8 },
      ],
    },
  ];
  const saved = await store.request({ action: 'save', ...request, version: 0, strokes }, document);
  assert.equal(saved.version, 1);
  await assert.rejects(
    store.request({ action: 'save', ...request, version: 0, strokes: [] }, document),
    /另一视图/,
  );
  const reopened = new AnnotationStore(root);
  assert.deepEqual((await reopened.request({ action: 'get', ...request }, document)).strokes, strokes);
  assert.equal((await reopened.request({ action: 'get', ...request, page: 1 }, document)).strokes.length, 0);
  assert.equal(
    (await store.request({ action: 'save', ...request, version: 1, strokes: [] }, document)).strokes.length,
    0,
  );
  await reopened.close();
});
test('批注拒绝路径越界、异常坐标、未知文档或过期版本来源', async (t) => {
  const root = await workspace(t),
    store = new AnnotationStore(root);
  t.after(() => store.close());
  assert.equal(
    annotationRequest.safeParse({ action: 'get', id: '../../note.md', page: 1, revision: 'b'.repeat(64) })
      .success,
    false,
  );
  assert.equal(
    annotationRequest.safeParse({
      action: 'save',
      id: 'doc-' + 'a'.repeat(24),
      page: 1,
      revision: 'b'.repeat(64),
      version: 0,
      strokes: [{ id: 'bad', tool: 'pen', color: '#ffffff', width: 0.003, points: [{ x: 2, y: 0 }] }],
    }).success,
    false,
  );
  await assert.rejects(
    store.request({ action: 'get', id: 'doc-' + 'a'.repeat(24), page: 2, revision: 'b'.repeat(64) }, {
      id: 'doc-' + 'a'.repeat(24),
      revision: 'c'.repeat(64),
      pages: 1,
    } as DocumentInfo),
    /来源或页码/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});
test('视觉文本投影不改变原始历史，并移除文本主模型不支持的像素与原生图像载荷', () => {
  const history = [
    {
      role: 'tool' as const,
      content: '原始页面',
      images: [{ id: 'img', mime: 'image/png', label: '原图', data: 'pixels' }],
      native: { image: 'native-pixels' },
    },
  ];
  const projected = textOnlyHistory(history);
  assert.equal(projected[0].images, undefined);
  assert.equal(projected[0].native, undefined);
  assert.match(projected[0].content, /未交给文本主模型/);
  assert.equal(history[0].images[0].data, 'pixels');
  assert.deepEqual(history[0].native, { image: 'native-pixels' });
});
test('浮窗桥接只接受已定义操作，不能请求任意URL或执行命令', () => {
  assert.equal(panelRequest.safeParse({ action: 'open', kind: 'assistant' }).success, true);
  assert.equal(panelRequest.safeParse({ action: 'navigate', target: 'shell', id: 'cmd.exe' }).success, false);
  assert.equal(
    panelRequest.safeParse({ action: 'open', kind: 'assistant', url: 'https://evil.test' }).success,
    false,
  );
});
