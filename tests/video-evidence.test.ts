import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers';
import { locateVideoQuestion } from '../apps/desktop/src/shared/video';
import { VideoCacheManager } from '../apps/desktop/src/core/video-cache';
import { LearningService } from '../apps/desktop/src/core/learning';
import { SourceRegistry } from '../apps/desktop/src/core/sources';
import { localSubtitles,biliSubtitles } from '../apps/desktop/src/main/video-subtitles';
test('B站字幕按分P查真实cid，使用当前播放器字幕接口并优先中文',async()=>{const urls:string[]=[];const ses={fetch:async(url:string)=>{urls.push(url);const value=url.includes('/view?')?{code:0,data:{pages:[{page:1,cid:111},{page:2,cid:987654}]}}:url.includes('/x/player/wbi/v2?')?{code:0,data:{subtitle:{subtitles:[{lan:'en',subtitle_url:'https://aisubtitle.hdslb.com/en.json'},{lan:'zh-CN',subtitle_url:'https://aisubtitle.hdslb.com/zh.json'}]}}}:{body:[{from:150,to:153,content:'二阶系统的阻尼比'}]};return new Response(JSON.stringify(value));}};const result=await biliSubtitles({id:'fixture',kind:'bilibili',platformVideoId:'BV1GJ411x7h7',partIndex:2,url:'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2'} as any,ses as any);assert.ok(urls[1].includes('/x/player/wbi/v2?'));assert.ok(urls[1].includes('cid=987654'));assert.ok(urls[2].endsWith('/zh.json'));assert.equal(result[0].text,'二阶系统的阻尼比');});
test('本地视频同名中文SRT和VTT以原时间解析，原字幕保持不变', async (t) => {
  const root = await workspace(t),
    video = path.join(root, '中文课程.mp4'),
    srt = path.join(root, '中文课程.srt'),
    text = '1\n00:02:30,000 --> 00:02:33,500\n阻尼比与超调量的关系。\n';
  await fs.writeFile(video, 'fixture');
  await fs.writeFile(srt, text);
  const rows = await localSubtitles(video);
  assert.equal(rows[0].from, 150);
  assert.equal(rows[0].to, 153.5);
  assert.equal(rows[0].text, '阻尼比与超调量的关系。');
  assert.equal(await fs.readFile(srt, 'utf8'), text);
});
test('中文提问时间、时间段与刚才使用冻结进度定位', () => {
  assert.deepEqual(locateVideoQuestion('解释02:30这里', 400, 900), {
    start: 147,
    end: 153,
    basis: '问题中的明确时间（供模型判断）',
  });
  assert.equal(locateVideoQuestion('1分20秒到2分30秒', 400).start, 80);
  assert.equal(locateVideoQuestion('1分20秒到2分30秒', 400).end, 150);
  assert.equal(locateVideoQuestion('刚才的推导', 60).start, 30);
  assert.equal(locateVideoQuestion('01:02:03的板书', 0).start, 3720);
});
test('定时清理设置可恢复，过期与超额淘汰只触及自动缓存文件', async (t) => {
  const root = await workspace(t),
    source = 'a'.repeat(24),
    folder = path.join(root, source, 'videos', 'session', 'preview');
  await fs.mkdir(folder, { recursive: true });
  const own = path.join(root, '保留笔记.md');
  await fs.writeFile(own, '用户资料');
  const write = async (name: string, size: number, at: string, archivePath?: string) => {
    await fs.writeFile(path.join(folder, name + '.webp'), Buffer.alloc(size));
    await fs.writeFile(
      path.join(folder, name + '.webp.json'),
      JSON.stringify({ archivePath: archivePath || `videos/session/preview/${name}.webp`, cachedAt: at }),
    );
  };
  await write('old', 10, '2020-01-01T00:00:00.000Z');
  await write('older', 17 * 1024 * 1024, new Date(Date.now() - 2000).toISOString());
  await write('newer', 17 * 1024 * 1024, new Date().toISOString());
  await write('outside', 4, '2020-01-01T00:00:00.000Z', own);
  const manager = new VideoCacheManager(root);
  await manager.configure({ enabled: true, retentionHours: 24, maxMegabytes: 32, cleanupMinutes: 1 });
  await manager.initialize();
  for(let i=0;i<200&&!manager.state.lastCleanup;i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(manager.state.lastCleanup);
  const status = manager.state;
  assert.equal(status.removed, 2);
  assert.equal(status.cachedFrames, 1);
  assert.equal(status.cachedBytes, 17 * 1024 * 1024);
  assert.equal(await fs.readFile(own, 'utf8'), '用户资料');
  assert.equal((await fs.stat(path.join(folder, 'outside.webp'))).size, 4);
  assert.ok(status.nextCleanup);
  await manager.close();
  const restored = new VideoCacheManager(root);
  await restored.initialize();
  assert.equal(restored.state.settings.maxMegabytes, 32);
  assert.equal(restored.state.settings.cleanupMinutes, 1);
  await restored.close();
});
test('按时间读取已缓存像素与完整字幕，提问后切课或新增字幕不会串入冻结证据', async (t) => {
  const root = await workspace(t),
    sources = new SourceRegistry(path.join(root, 'sources.json'));
  await sources.initialize();
  const learning = new LearningService(path.join(root, 'evidence'), sources);
  t.after(() => learning.close());
  const binding = sources.bind('https://example.com/lesson-a');
  const observation = (seq: number, time: number) => ({
    binding,
    seq,
    url: binding.url,
    title: '课程A',
    currentTime: time,
    duration: 300,
    paused: false,
    playbackRate: 1,
    frameStatus: 'captured',
    subtitle: null,
    frame: {
      timestamp: time,
      width: 8,
      height: 8,
      data: 'data:image/webp;base64,UklGRg==',
      mimeType: 'image/webp' as const,
      source: 'canvas' as const,
      qualityLevel: 'preview' as const,
      hash: '1'.repeat(64),
    },
  });
  await learning.observe({
    ...observation(1, 10),
    captions: [{ from: 150, to: 153, text: '阻尼比影响超调量', source: 'text-track' }],
  });
  const anchor = learning.freeze();
  await learning.observe({
    ...observation(2, 12),
    captions: [{ from: 150, to: 153, text: '发送后才出现的文字', source: 'text-track' }],
  });
  const other = sources.bind('https://example.com/lesson-b');
  await learning.observe({ ...observation(1, 10), binding: other, url: other.url });
  const packet = await learning.frames(anchor, 9, 11, 1);
  assert.equal(packet.frames.length, 1);
  assert.equal(packet.frames[0].timestamp, 10);
  assert.ok(packet.frames[0].data?.startsWith('data:image/webp;base64,'));
  assert.equal(learning.subtitles(anchor, 149, 154, '阻尼', 10)[0].text, '阻尼比影响超调量');
  assert.equal(learning.subtitles(anchor, 149, 154, '发送后', 10).length, 0);
  await learning.close();
  const restored = new LearningService(path.join(root, 'evidence'), sources);
  t.after(() => restored.close());
  await restored.observe({
    ...observation(3, 11),
    binding: sources.bind(binding.url),
    frame: null,
    frameStatus: 'not-requested',
  });
  const next = restored.freeze();
  assert.equal((await restored.frames(next, 9, 11, 1)).frames.length, 1);
  assert.equal(restored.subtitles(next, 149, 154, '阻尼', 10).length, 1);
});
