import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LearningService } from '../apps/desktop/src/core/learning';
import { SourceRegistry } from '../apps/desktop/src/core/sources';
import {
  observationSchema,
  type ObservationBinding,
  type ObservationInput,
} from '../apps/desktop/src/shared/contracts';
import { FrameArchive } from '../vendor/video-observer/src/cache/FrameArchive.mjs';
import { FrameCapture } from '../vendor/video-observer/src/video/FrameCapture.mjs';
import { normalizeSnapshot } from '../vendor/video-observer/src/browser/BrowserAdapter.mjs';
import { SceneDetector } from '../vendor/video-observer/src/analysis/SceneDetector.mjs';
import { workspace } from './helpers';

const sample = (binding: ObservationBinding, subtitle: string): ObservationInput => ({
  binding,
  seq: 1,
  url: binding.url,
  title: subtitle,
  currentTime: 30,
  duration: 100,
  paused: false,
  playbackRate: 1,
  frameStatus: 'captured',
  subtitle,
  frame: {
    timestamp: 30,
    width: 8,
    height: 8,
    data: 'data:image/webp;base64,UklGRg==',
    hash: '0'.repeat(32) + '1'.repeat(32),
    mimeType: 'image/webp',
    source: 'canvas',
    qualityLevel: 'preview',
  },
});
test('指纹通过完整归一化/帧校验链，相同帧不再全部切场景', () => {
  const binding = { sourceId: 'test', visitId: 'v', generation: 1, url: 'https://example.com/a' };
  const first = sample(binding, '字幕');
  const normalized = normalizeSnapshot({ ...first, frame: first.frame });
  const frame = new FrameCapture().captureFromSnapshot(normalized)!;
  assert.equal(frame.hash, first.frame!.hash);
  const scenes = new SceneDetector();
  assert.equal(scenes.observe(frame).sceneCut, true);
  assert.equal(scenes.observe({ ...frame, timestamp: 45 }).sceneCut, false);
  const unknown = new SceneDetector();
  unknown.observe({ timestamp: 0 });
  assert.equal(unknown.observe({ timestamp: 1 }).comparison.known, false);
  assert.equal(unknown.observe({ timestamp: 2 }).sceneCut, false);
});
test('切视频后仍从原来源读取冻结证据，归档保留指纹且跨重启不清理', async (t) => {
  const root = await workspace(t);
  const sources = new SourceRegistry(path.join(root, 'sources.json'));
  await sources.initialize();
  const learning = new LearningService(path.join(root, 'evidence'), sources);
  t.after(async () => {
    await learning.close();
    await sources.flush();
  });
  const first = sources.bind('https://example.com/a');
  await learning.observe(sample(first, 'A课阻尼比'));
  const request = learning.freeze();
  const second = sources.bind('https://example.com/b');
  await learning.observe(sample(second, 'B课其他内容'));
  const context = await learning.context(request);
  assert.equal(context.anchor.sourceId, first.sourceId);
  assert.equal(context.subtitles[0].text, 'A课阻尼比');
  assert.equal(context.frames.length, 1);
  assert.notEqual(learning.playback()!.sourceId, request.sourceId);
  await learning.close();
  const restored = new FrameArchive(path.join(root, 'evidence', first.sourceId), {
    clearOnReboot: false,
    bootIdProvider: () => 'different-system-boot',
  });
  await restored.initialize();
  const sessions = await restored.listSessions({ includeData: false });
  assert.equal(sessions[0].archiveFrames[0].hash, sample(first, 'A').frame!.hash);
});
test('观察合约限制图像大小、异常数字和未知权限字段', () => {
  const input = sample({ sourceId: 's', visitId: 'v', generation: 1, url: 'https://example.com' }, '字幕');
  assert.equal(observationSchema.safeParse(input).success, true);
  assert.equal(observationSchema.safeParse({ ...input, currentTime: Infinity }).success, false);
  assert.equal(observationSchema.safeParse({ ...input, token: 'not-accepted' }).success, false);
  assert.equal(
    observationSchema.safeParse({ ...input, frame: { ...input.frame, width: 2000 } }).success,
    false,
  );
});
