import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SourceRegistry, identifySource, normalizeWebUrl } from '../apps/desktop/src/core/sources';
import { workspace } from './helpers';

test('B站分P有独立身份，追踪参数不改变来源', async (t) => {
  const root = await workspace(t);
  const sources = new SourceRegistry(path.join(root, 'sources.json'));
  await sources.initialize();
  const first = sources.bind('https://www.bilibili.com/video/BV123?p=1&token=secret');
  const second = sources.bind('https://www.bilibili.com/video/BV123?p=2');
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal(sources.get(second.sourceId).partIndex, 2);
  assert.equal(
    identifySource('https://www.bilibili.com/video/BV123?p=2&spm_id_from=test').canonicalKey,
    sources.get(second.sourceId).canonicalKey,
  );
  assert.equal(normalizeWebUrl('https://example.com/?token=secret&x=1'), 'https://example.com/?x=1');
  await sources.flush();
});
test('导航后的旧回调与同一会话的乱序帧被拒绝', async (t) => {
  const root = await workspace(t);
  const sources = new SourceRegistry(path.join(root, 'sources.json'));
  await sources.initialize();
  const first = sources.bind('https://example.com/a');
  sources.accepts(first, first.url, 1);
  assert.throws(() => sources.accepts(first, first.url, 1), { code: 'STALE_SEQUENCE' });
  const second = sources.bind('https://example.com/b');
  assert.throws(() => sources.accepts(first, first.url, 2), { code: 'STALE_SOURCE' });
  assert.throws(() => sources.accepts(second, first.url, 1), { code: 'SOURCE_MISMATCH' });
  await sources.flush();
});
test('冻结请求不随当前视频切换，重启保留来源但不冒充实时连接', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'sources.json');
  const sources = new SourceRegistry(file);
  await sources.initialize();
  const first = sources.bind('https://example.com/a');
  const request = sources.freeze({
    sourceId: first.sourceId,
    currentTime: 42,
    duration: 100,
    paused: false,
    playbackRate: 1,
    observedAt: new Date().toISOString(),
    frameStatus: 'captured',
    subtitleCount: 0,
    frameCount: 1,
  });
  sources.bind('https://example.com/b');
  assert.equal(Object.isFrozen(request), true);
  assert.equal(request.sourceId, first.sourceId);
  assert.equal(request.mediaTime, 42);
  await sources.flush();
  const restored = new SourceRegistry(file);
  await restored.initialize();
  assert.equal(restored.list().length, 2);
  assert.equal(restored.active, null);
});
test('文件协议、脚本协议和URL凭据不能进入网页来源', () => {
  for (const url of [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'https://user:password@example.com',
  ])
    assert.throws(() => normalizeWebUrl(url), { code: 'INVALID_URL' });
});
