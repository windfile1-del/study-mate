import { _electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = process.cwd(),
  packed = process.argv.includes('--packed');
const data = path.join(root, '.cache', 'polish-070-' + Date.now()),
  vault = path.join(data, 'vault'),
  artifacts = path.join(root, 'artifacts', packed ? 'polish-packed' : 'polish');
await fs.mkdir(vault, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const realVault = JSON.parse(
  await fs.readFile(path.join(root, '.local/data/state/workspace.json'), 'utf8'),
).vaultPath;
const samples = [
  '01 数学/01 高等数学/05 多元函数/多元函数微分学与二重积分讲义.md',
  '02 自动控制原理/11 例题/02 时域分析/二阶过阻尼系统动态指标与闭环主导极点估算例题.md',
];
const originals = await Promise.all(samples.map((file) => fs.readFile(path.join(realVault, file))));
for (let i = 0; i < samples.length; i++) {
  const target = path.join(vault, samples[i]);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, originals[i]);
}
const video = await fs.readFile(path.join(root, '.cache/fixtures/flower.mp4'));
const requests = [];
let pending = null,
  slow = true;
const server = http.createServer(async (req, res) => {
  if (req.url === '/course')
    return res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        `<!doctype html><style>body{background:#fff5ed;color:#45352b;margin:25px}.wrap{transform:translateZ(0);width:380px;position:relative;overflow:hidden}video{width:320px;height:200px}.danmaku{position:absolute;top:30px;color:red}.bpx-player-subtitle-wrap{position:absolute;bottom:20px;color:blue}</style><h1>有评论与弹幕的课程页</h1><div class="wrap"><video controls preload="auto" src="/video"><track default kind="subtitles" srclang="zh" src="/captions.vtt"></video><div class="danmaku">测试滚动弹幕</div><div class="bpx-player-subtitle-wrap">课程示例字幕</div></div><div id="comments">评论区内容</div>`,
      );
  if (req.url === '/captions.vtt')
    return res
      .writeHead(200, { 'Content-Type': 'text/vtt' })
      .end('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n测试字幕\n');
  if (req.url === '/video') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0,
      end = range && range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}),
    });
    return res.end(video.subarray(start, end + 1));
  }
  if (req.url === '/models')
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        data: [
          { id: 'fixture-basic', supported_reasoning_efforts: ['low', 'high'] },
          { id: 'fixture-advanced', supported_reasoning_efforts: ['low', 'high'] },
        ],
      }),
    );
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '已收到问题。' } }] }) + '\n\n');
  const finish = () =>
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 2100,
            completion_tokens: 20,
            total_tokens: 2120,
            prompt_tokens_details: { cached_tokens: 1800 },
          },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  if (slow) pending = finish;
  else finish();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
let app, page;
const result = { passed: false, checks: [], screenshots: [], errors: [] };
async function until(fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error('等待条件超时');
}
async function shot(name) {
  const target = path.join(artifacts, name + '.png');
  await page.screenshot({ path: target, timeout: 30000 });
  result.screenshots.push(target);
}
async function remote(script) {
  return app.evaluate(({ BrowserWindow }, code) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => 'webContents' in v);
    return view.webContents.executeJavaScript(code);
  }, script);
}
try {
  const executable =
    process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.10.0/win-unpacked/Study Mate.exe');
  const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (packed) {
    env.PATH = 'C:\\Windows\\System32;C:\\Windows';
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
  }
  app = await _electron.launch({
    executablePath: packed ? executable : electronPath,
    cwd: packed ? path.dirname(executable) : root,
    args: packed ? [] : [root],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, vault);
  await page.getByRole('button', { name: '切换知识库', exact: true }).click();
  for (let i = 0; i < samples.length; i++) {
    const name = path.basename(samples[i], '.md');
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(name);
    await page
      .locator('.search-results button')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first()
      .click();
    await page.locator('.note-toolbar').filter({ hasText: name }).waitFor();
    await page.locator('.note-preview[data-compiling="false"]').first().waitFor({ timeout: 45000 });
    const select = page.getByRole('combobox', { name: '笔记目录' });
    const option = await select
      .locator('option')
      .evaluateAll(
        (options, index) =>
          options.find((o) => o.textContent.includes(index === 0 ? '特征根法的完整证明' : '特征'))?.value,
        i,
      );
    if (option) await select.selectOption(option);
    await page.locator('.note-preview .katex').first().waitFor();
    assert.equal(await page.locator('.note-preview .katex-error').count(), 0);
    if (i === 0) {
      assert.ok(await select.locator('option').filter({ hasText: '3.5 例题' }).count());
      await page.locator('.note-preview-scroll').evaluate((el) => {
        el.scrollTop += 500;
      });
      await page.waitForTimeout(300);
    }
    await shot('0' + (i + 1) + '-note');
    assert.deepEqual(await fs.readFile(path.join(realVault, samples[i])), originals[i]);
    assert.deepEqual(await fs.readFile(path.join(vault, samples[i])), originals[i]);
  }
  result.checks.push(
    'Both exact user notes render with zero math errors; downstream headings remain; original and copied Markdown bytes unchanged',
  );
  await page.evaluate(async (base) => {
    const s = await window.studyMate.ai({ action: 'state' });
    await window.studyMate.ai({
      action: 'configure',
      config: { ...s.config, preset: 'custom', protocol: 'chat', baseUrl: base, model: 'fixture-basic' },
      key: 'fixture',
    });
  }, base);
  await page.getByRole('button', { name: '刷新对话模型列表', exact: true }).click();
  await page.getByRole('textbox', { name: '伴学提问', exact: true }).fill('开始第一问');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(() => requests.length === 1);
  await page.getByRole('combobox', { name: '对话模型', exact: true }).selectOption('fixture-advanced');
  await page.getByRole('combobox', { name: '对话推理强度', exact: true }).selectOption('high');
  assert.equal(requests[0].model, 'fixture-basic');
  assert.equal(requests[0].reasoning_effort, undefined);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await until(async () => {
    const s = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
    return s.config.model === 'fixture-advanced' && s.config.effort === 'high';
  });
  pending();
  slow = false;
  await until(() => page.evaluate(() => window.studyMate.ai({ action: 'state' }).then((s) => !s.busy)));
  await page.getByRole('textbox', { name: '伴学提问', exact: true }).fill('下一问使用新模型');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(() => requests.length === 2);
  assert.equal(requests[1].model, 'fixture-advanced');
  assert.equal(requests[1].reasoning_effort, 'high');
  await until(() => page.evaluate(() => window.studyMate.ai({ action: 'state' }).then((s) => !s.busy)));
  await shot('03-quick-model');
  result.checks.push(
    'Model and reasoning switch directly during generation, keep original request fixed, apply to next request and persist without settings modal',
  );
  await page.getByRole('button', { name: '手动输入对话模型', exact: true }).click();
  await page.getByRole('textbox', { name: '输入对话模型ID', exact: true }).fill('fixture-manual');
  await page.getByRole('textbox', { name: '输入对话模型ID', exact: true }).press('Enter');
  await until(() =>
    page.evaluate(() =>
      window.studyMate.ai({ action: 'state' }).then((s) => s.config.model === 'fixture-manual'),
    ),
  );
  await page.getByRole('combobox', { name: '对话模型', exact: true }).selectOption('fixture-advanced');
  await page.getByRole('combobox', { name: '对话推理强度', exact: true }).selectOption('high');
  await page.getByRole('button', { name: '课程浏览器', exact: true }).click();
  await page.getByRole('textbox', { name: '浏览器地址', exact: true }).fill(base + '/course');
  await page.getByRole('button', { name: '前往网页', exact: true }).click();
  await until(() =>
    remote('!!document.querySelector("video") && document.querySelector("video").readyState >= 2'),
  );
  const original = await remote(
    '({style:document.querySelector("video").getAttribute("style"),width:document.querySelector("video").getBoundingClientRect().width,controls:document.querySelector("video").controls})',
  );
  await page.getByRole('button', { name: '纯视频模式', exact: true }).click();
  await until(() =>
    page
      .getByRole('button', { name: '纯视频模式', exact: true })
      .getAttribute('aria-pressed')
      .then((x) => x === 'true'),
  );
  const focused = await remote(
    '({comment:getComputedStyle(document.querySelector("#comments")).visibility,danmaku:getComputedStyle(document.querySelector(".danmaku")).visibility,video:getComputedStyle(document.querySelector("video")).visibility,width:document.querySelector("video").getBoundingClientRect().width,viewport:innerWidth,api:typeof window.studyMate})',
  );
  assert.equal(focused.comment, 'hidden');
  assert.equal(focused.danmaku, 'hidden');
  assert.equal(focused.video, 'visible');
  assert.ok(Math.abs(focused.width - focused.viewport) < 2);
  assert.equal(focused.api, 'undefined');
  await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('1.5');
  assert.equal(await remote('document.querySelector("video").playbackRate'), 1.5);
  await page.getByRole('button', { name: '播放视频', exact: true }).click();
  await until(() => remote('!document.querySelector("video").paused'));
  await page.getByRole('button', { name: '暂停视频', exact: true }).click();
  await until(() => remote('document.querySelector("video").paused'));
  const slider = page.getByRole('slider', { name: '视频进度', exact: true });
  await slider.focus();
  await slider.press('Home');
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await until(() => remote('document.querySelector("video").currentTime > 0'));
  await page.getByRole('button', { name: '切换视频字幕', exact: true }).click();
  await until(() =>
    remote('getComputedStyle(document.querySelector(".bpx-player-subtitle-wrap")).visibility==="hidden"'),
  );
  await page.getByRole('button', { name: '切换视频字幕', exact: true }).click();
  await until(() =>
    remote('getComputedStyle(document.querySelector(".bpx-player-subtitle-wrap")).visibility==="visible"'),
  );
  const native = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => 'webContents' in v);
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  });
  await fs.writeFile(path.join(artifacts, '04-native-focus.png'), Buffer.from(native, 'base64'));
  await shot('04-player-controls');
  const nativeWindow = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const win = BrowserWindow.getAllWindows()[0],
      sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1900, height: 1300 },
      });
    return sources
      .find((s) => s.id === win.getMediaSourceId())
      ?.thumbnail.toPNG()
      .toString('base64');
  });
  if (nativeWindow) {
    await fs.writeFile(path.join(artifacts, '04-native-window.png'), Buffer.from(nativeWindow, 'base64'));
    result.screenshots.push(path.join(artifacts, '04-native-window.png'));
  }
  await page.getByRole('button', { name: '纯视频模式', exact: true }).click();
  const restored = await remote(
    '({comment:getComputedStyle(document.querySelector("#comments")).visibility,width:document.querySelector("video").getBoundingClientRect().width,style:document.querySelector("video").getAttribute("style"),controls:document.querySelector("video").controls})',
  );
  assert.equal(restored.comment, 'visible');
  assert.equal(restored.style || '', original.style || '');
  assert.equal(restored.width, original.width);
  assert.equal(restored.controls, original.controls);
  await assert.rejects(page.evaluate(() => window.studyMate.player({ action: 'rate', rate: 100 })));
  await shot('05-restored-webpage');
  result.checks.push(
    'Pure-video uses existing DOM video, hides comments/danmaku, controls real play/pause/rate/seek/captions and restores styles/controls; remote page has no privileged bridge',
  );
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (e) {
  result.error = e.stack;
  process.exitCode = 1;
  if (page) await shot('failure').catch(() => {});
} finally {
  if (app)
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
