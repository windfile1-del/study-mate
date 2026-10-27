import { _electron } from 'playwright-core';
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = process.cwd(),
  packed = process.argv.includes('--packed'),
  data = path.join(root, '.cache', 'video-evidence-' + Date.now()),
  artifacts = path.join(root, 'artifacts', packed ? 'video-packed' : 'video');
await fs.mkdir(data, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const movie = await fs.readFile(path.join(root, '.cache/fixtures/flower.mp4')),
  requests = [];
let releaseFirst,
  firstSeen = false;
const gate = new Promise((r) => (releaseFirst = r));
const result = { passed: false, checks: [], screenshots: [], errors: [], timing: {} };
let app, page;
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    req.setEncoding('utf8');
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const tools = payload.messages.filter((m) => m.role === 'tool');
    let call;
    if (!tools.length) {
      firstSeen = true;
      await gate;
      call = ['search_video_subtitles', { query: '阻尼比', start: 0, end: 300, limit: 10 }];
    } else if (tools.length === 1) call = ['read_video_frames', { start: 1, end: 4, frames: 3 }];
    else if (tools.length === 2) call = ['watch_video', { start: 1, end: 3, detail: 'overview' }];
    else if (tools.length === 3) call = ['read_video_subtitles', { start: 1, end: 4 }];
    else if (tools.length === 4) call = ['analyze_video', { start: 0.5, end: 1.5, frames: 2 }];
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'video-' + tools.length,
              type: 'function',
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        }
      : {
          content:
            '已依据原课程的字幕、缓存和后台原视频片段进行核对。抽样画面不代表完整观看，术语请核对原音。',
        };
    res
      .writeHead(200, { 'Content-Type': 'text/event-stream' })
      .end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }],
            usage: {
              prompt_tokens: 4000,
              completion_tokens: 80,
              total_tokens: 4080,
              prompt_tokens_details: { cached_tokens: 3000 },
            },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    return;
  }
  if (req.url === '/movie') {
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''),
      start = match ? +match[1] : 0,
      end = match?.[2] ? Math.min(+match[2], movie.length - 1) : movie.length - 1;
    res
      .writeHead(match ? 206 : 200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${movie.length}` } : {}),
      })
      .end(movie.subarray(start, end + 1));
    return;
  }
  if (req.url === '/captions.vtt') {
    res
      .writeHead(200, { 'Content-Type': 'text/vtt;charset=utf-8' })
      .end(
        'WEBVTT\n\n00:00.000 --> 00:01.500\n课程开始，先观察闭环系统。\n\n00:01.500 --> 00:03.500\n阻尼比会影响超调量，需结合图像核对。CHINESE_SUBTITLE_EVIDENCE_ONLY_BY_TOOL\n\n00:03.500 --> 00:05.000\n稳定性与调节时间也需要考虑。\n',
      );
    return;
  }
  const other = req.url === '/other',
    blob = req.url === '/blob';
  res
    .writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
    .end(
      '<title>' +
        (other ? '另一门课B' : '原课程A') +
        '</title><style>body{margin:0;background:#263f37}video{width:900px;height:510px}</style><video controls muted loop ' +
        (!blob ? 'src="/movie"' : '') +
        '><track kind="subtitles" srclang="zh" default src="/captions.vtt"></video><script>window.controlWrites={seek:0,pause:0,rate:0,volume:0};for(const key of ["currentTime","playbackRate","volume"]){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(v){window.controlWrites[key==="currentTime"?"seek":key==="playbackRate"?"rate":"volume"]++;d.set.call(this,v)}})}const p=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(){window.controlWrites.pause++;return p.call(this)};' +
        (blob
          ? 'fetch("/movie").then(r=>r.blob()).then(b=>{document.querySelector("video").src=URL.createObjectURL(b)});'
          : '') +
        '</script>',
    );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const until = async (fn, timeout = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('视频验收等待超时');
};
const shot = async (name) => {
  const file = path.join(artifacts, name + '.png');
  await page.screenshot({ path: file });
  result.screenshots.push(file);
};
try {
  const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (packed) {
    env.PATH = 'C:\\Windows\\System32;C:\\Windows';
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
  }
  const executable =
    process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.10.0/win-unpacked/Study Mate.exe');
  app = await _electron.launch({
    executablePath: packed ? executable : electron,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await page.evaluate((url) => window.studyMate.openWeb(url), origin + '/blob');
  await until(() => page.evaluate(() => window.studyMate.state().then((s) => s.playback?.duration > 4)));
  await page.evaluate(() => window.studyMate.player({ action: 'play' }));
  await until(() =>
    page.evaluate(() =>
      window.studyMate.state().then((s) => s.playback?.frameCount >= 3 && s.playback?.subtitleCount >= 3),
    ),
  );
  await page.evaluate(() => window.studyMate.player({ action: 'pause' }));
  const source = (await page.evaluate(() => window.studyMate.state())).activeBinding.sourceId;
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  await page.getByRole('button', { name: '视频缓存', exact: true }).click();
  await page.getByRole('combobox', { name: '视频缓存清理频率' }).selectOption('1');
  await page.getByRole('button', { name: '保存缓存设置', exact: true }).click();
  await page.getByText('已保存，按新设置定时清理。', { exact: true }).waitFor();
  await shot('01-cache-settings');
  const metadata = path.join(
      data,
      'evidence',
      source,
      'videos',
      'expired-fixture',
      'preview',
      'old.webp.json',
    ),
    expired = metadata.slice(0, -5);
  await fs.mkdir(path.dirname(metadata), { recursive: true });
  await fs.writeFile(expired, movie.subarray(0, 40));
  await fs.writeFile(
    metadata,
    JSON.stringify({
      archivePath: 'videos/expired-fixture/preview/old.webp',
      cachedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  const cleanupStart = Date.now();
  await page.getByRole('button', { name: '返回学习', exact: true }).click();
  result.checks.push(
    'Background low-resolution frames and complete Chinese text-track cues are cached without manual capture; cache settings have readable defaults and persist',
  );
  await page.evaluate(async (url) => {
    const current = await window.studyMate.ai({ action: 'state' });
    await window.studyMate.ai({
      action: 'configure',
      config: {
        ...current.config,
        preset: 'custom',
        protocol: 'chat',
        baseUrl: url,
        model: 'controlled-video-vision',
        contextSize: 65536,
        maxOutput: 1024,
      },
      key: 'fixture',
    });
  }, origin);
  await page
    .getByRole('textbox', { name: '伴学提问' })
    .fill('请解释00:02到00:04这一段阻尼比的讲解，并主动在后台查看合适的原视频片段。');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(() => firstSeen);
  await page.evaluate((url) => window.studyMate.openWeb(url), origin + '/other');
  await until(() =>
    page.evaluate(() =>
      window.studyMate.player({ action: 'state' }).then((s) => s.available && s.duration > 4),
    ),
  );
  await page.evaluate(() => window.studyMate.player({ action: 'seek', time: 3 }));
  await page.evaluate(() => window.studyMate.player({ action: 'pause' }));
  const before = await app.evaluate(({ WebContentsView, BrowserWindow, webContents }) => {
    const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/other'));
    return view.executeJavaScript(
      '({writes:window.controlWrites,time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused})',
    );
  });
  releaseFirst();
  await until(
    () =>
      page.evaluate(() =>
        window.studyMate
          .ai({ action: 'state' })
          .then((s) => !s.busy && s.messages.at(-1)?.status === 'complete'),
      ),
    180000,
  );
  const ai = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  assert.equal(ai.messages.at(-1).tools.length, 5, JSON.stringify(ai.messages.at(-1)));
  assert.ok(
    ai.messages.at(-1).tools.every((t) => t.status === 'complete'),
    JSON.stringify(ai.messages.at(-1).tools),
  );
  assert.equal(requests[0].tools.length, 23);
  assert.ok(JSON.stringify(requests[0]).includes('suggestedRange'));
  assert.ok(!JSON.stringify(requests[0]).includes('CHINESE_SUBTITLE_EVIDENCE_ONLY_BY_TOOL'));
  const toolMessages = requests
    .at(-1)
    .messages.filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(m.content));
  assert.match(toolMessages[0].subtitles[0].text, /阻尼比/);
  assert.ok(toolMessages[1].frames.length >= 1);
  assert.equal(toolMessages[2].sourceId, source);
  assert.equal(toolMessages[2].mode, 'original-video-segment');
  assert.equal(toolMessages[2].frames.length, 6);
  assert.ok(toolMessages[2].frames.every((f) => f.citation.startsWith('study-video://' + source + '/')));
  assert.ok(
    requests.some((r) =>
      r.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')),
    ),
  );
  const after = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((w) => w.getURL().endsWith('/other'))
      .executeJavaScript(
        '({writes:window.controlWrites,time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused})',
      ),
  );
  assert.deepEqual(after, before);
  await shot('02-autonomous-video-tools');
  result.checks.push(
    'Chinese timestamp hint, subtitle search/read and cached pixel tools run on demand; first request only contains metadata and 23 stable tools',
  );
  result.checks.push(
    'Model-selected original Blob video segments decode in a separate background page after foreground switches courses; watch_video and analyze_video return actual pixels/times without moving foreground playback',
  );
  await until(async () => {
    const s = await page.evaluate(() => window.studyMate.videoCache({ action: 'state' }));
    return s.lastCleanup && Date.parse(s.lastCleanup) >= cleanupStart && s.removed >= 1;
  }, 90000);
  await assert.rejects(fs.access(expired));
  result.timing.scheduledCleanupMs = Date.now() - cleanupStart;
  result.checks.push(
    'Real one-minute timer removes expired automatic frames; cleanup does not depend on clicking the manual cleanup button',
  );
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  await page.getByRole('button', { name: '视频缓存', exact: true }).click();
  await shot('03-scheduled-cleanup');
  await page.getByRole('button', { name: '返回学习', exact: true }).click();
  await app.close();
  app = null;
  app = await _electron.launch({
    executablePath: packed ? executable : electron,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
  });
  page = await app.firstWindow();
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.studyMate.videoCache({ action: 'state' }))).settings.cleanupMinutes,
    1,
  );
  assert.deepEqual(result.errors, []);
  result.checks.push('Cache configuration survives a full application restart');
  result.passed = true;
} catch (e) {
  result.error = e.stack || String(e);
  process.exitCode = 1;
  if (page) await shot('failure').catch(() => {});
} finally {
  releaseFirst();
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
