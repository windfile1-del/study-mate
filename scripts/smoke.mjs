import { _electron } from 'playwright-core';
import executablePath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = process.cwd();
const development = process.argv.includes('--dev');
const artifacts = path.join(root, 'artifacts', development ? 'core-smoke-dev' : 'core-smoke');
const dataDir = path.join(root, '.cache', 'smoke-' + Date.now());
await fs.mkdir(artifacts, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
const findings = {
  passed: false,
  mode: development ? 'development-renderer' : 'production-build',
  at: new Date().toISOString(),
  dataDir,
  checks: [],
  pageErrors: [],
  screenshots: [],
};
const fixture = (
  label,
) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>核心验收课程${label}</title>
<style>body{margin:0;background:#eff3ed;font-family:"Microsoft YaHei",sans-serif;color:#365341}h2{font-weight:500;margin:22px}video{width:100%;background:#17372c}.bpx-player-subtitle-wrap{margin:18px;font-size:18px}</style></head>
<body><h2>课程${label} · 只读观察验收</h2><canvas id="source" width="960" height="540" hidden></canvas><video autoplay muted playsinline></video>
<div class="bpx-player-subtitle-wrap">课程${label}：阻尼比决定振荡的衰减速度。</div>
<script>
window.controlWrites={seek:0,pause:0,rate:0,volume:0};
for(const key of ['currentTime','playbackRate','volume']){const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...descriptor,set(value){window.controlWrites[key==='currentTime'?'seek':key==='playbackRate'?'rate':'volume']++;descriptor.set.call(this,value)}})}
const pause=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(){window.controlWrites.pause++;return pause.call(this)};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),video=document.querySelector('video');
let step=0;function draw(){step++;ctx.fillStyle='#17372c';ctx.fillRect(0,0,960,540);ctx.fillStyle='#cce1c7';ctx.font='34px sans-serif';ctx.fillText('CONTROL THEORY · ${label}',65,95);ctx.font='26px sans-serif';ctx.fillText('Damping ratio and system response',65,150);ctx.strokeStyle='#a4ce88';ctx.lineWidth=4;ctx.beginPath();for(let x=0;x<780;x++){const y=330-Math.exp(-x/250)*Math.sin(x/40)*120;if(x===0)ctx.moveTo(70+x,y);else ctx.lineTo(70+x,y)}ctx.stroke();ctx.fillStyle='#99ba8a';ctx.font='18px monospace';ctx.fillText('Local fixture frame '+step,65,485)}
draw();video.srcObject=canvas.captureStream(12);video.play();setInterval(draw,83);
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(fixture(request.url?.startsWith('/b') ? 'B' : 'A'));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let application;
let page;
let devServer;
async function waitForState(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await page.evaluate(() => window.studyMate.state());
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    '等待应用状态超时：' +
      JSON.stringify({
        playback: state?.playback,
        tasks: state?.tasks,
        contextFrames: state?.context?.frames.length,
      }),
  );
}
const screenshot = async (name) => {
  const filename = path.join(artifacts, name + '.png');
  // CDP waits for the shell's committed paint; native capturePage can return
  // the previous compositor frame when the test window is hidden.
  await page.screenshot({ path: filename, animations: 'disabled' });
  findings.screenshots.push(filename);
};
try {
  const env = { ...process.env, STUDYMATE_DATA_DIR: dataDir, STUDYMATE_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (development) {
    const { createServer } = await import('vite');
    const { default: configuration } = await import('../electron.vite.config.ts');
    devServer = await createServer({
      ...configuration.renderer,
      configFile: false,
      server: { host: '127.0.0.1', port: 0 },
      clearScreen: false,
    });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = devServer.resolvedUrls.local[0];
  }
  application = await _electron.launch({ executablePath, args: [root], env, timeout: 30000 });
  application.process().stderr?.on('data', (chunk) => {
    if (process.env.STUDYMATE_SMOKE_VERBOSE) process.stderr.write(chunk);
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => findings.pageErrors.push(error.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  findings.runtime = await application.evaluate(() => process.versions);
  const initial = await page.evaluate(() => window.studyMate.state());
  assert.ok(initial.vaultPath.toLowerCase().startsWith(dataDir.toLowerCase()));
  assert.equal(initial.provider.configured, false);
  findings.checks.push('应用启动、独立D盘profile与默认知识库');
  await screenshot('01-home');

  await page.getByRole('button', { name: /写一篇新笔记/ }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 笔记内容', exact: true });
  await editor.fill('# 核心验收笔记\n\n阻尼比决定振荡的衰减速度。\n');
  await page.getByRole('button', { name: /^保存/ }).click();
  await page.getByText('已保存到本地', { exact: true }).waitFor();
  const files = await fs.readdir(initial.vaultPath);
  const savedName = files.find((name) => name.startsWith('学习笔记-') && name.endsWith('.md'));
  assert.ok(savedName);
  assert.match(await fs.readFile(path.join(initial.vaultPath, savedName), 'utf8'), /核心验收笔记/);
  findings.checks.push('现成编辑器真实保存普通Markdown');
  await screenshot('02-note');

  await editor.fill('# 保留在编辑器的草稿\n\n不要覆盖外部修改。');
  await fs.appendFile(path.join(initial.vaultPath, savedName), '\n外部编辑器新增的内容\n');
  await page.getByRole('button', { name: /^保存/ }).click();
  await page.getByRole('alert').filter({ hasText: '修改' }).waitFor();
  assert.match(await fs.readFile(path.join(initial.vaultPath, savedName), 'utf8'), /外部编辑器新增/);
  assert.equal(await editor.inputValue(), '# 保留在编辑器的草稿\n\n不要覆盖外部修改。');
  await screenshot('03-conflict');
  await page.getByRole('button', { name: '另存副本', exact: true }).click();
  await page.getByText('已保存到本地', { exact: true }).waitFor();
  assert.ok((await fs.readdir(initial.vaultPath)).some((name) => name.includes('副本')));
  findings.checks.push('外部修改冲突保留双方内容，可另存草稿副本');
  await editor.fill('# 未保存草稿\n\n关闭窗口时需要保留。');
  await page.evaluate(() => window.studyMate.setDirty(true));
  await application.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.__originalMessageBox = dialog.showMessageBox;
    globalThis.__closePromptCount = 0;
    dialog.showMessageBox = async () => {
      globalThis.__closePromptCount++;
      return { response: 0, checkboxChecked: false };
    };
    BrowserWindow.getAllWindows()[0].close();
  });
  const closeGuard = await application.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBox = globalThis.__originalMessageBox;
    return { promptCount: globalThis.__closePromptCount, windowCount: BrowserWindow.getAllWindows().length };
  });
  assert.equal(closeGuard.promptCount, 1);
  assert.equal(closeGuard.windowCount, 1);
  assert.match(await editor.inputValue(), /未保存草稿/);
  await page.getByRole('button', { name: /^保存/ }).click();
  await page.getByText('已保存到本地', { exact: true }).waitFor();
  findings.checks.push('关闭保护触发（模拟选择返回保存），草稿保留并可继续保存');

  await page.evaluate((url) => window.studyMate.openWeb(url), origin + '/a');
  await page.locator('.nav-item').filter({ hasText: '课程浏览器' }).click();
  await page.locator('.browser-pane').waitFor();
  const before = await waitForState((state) => state.playback?.frameCount > 0);
  assert.ok(before.playback.currentTime >= 0);
  assert.ok(before.playback.subtitleCount > 0);
  const policy = await application.evaluate(async ({ BrowserWindow, webContents }) => {
    const shell = BrowserWindow.getAllWindows()[0].webContents;
    const remote = webContents
      .getAllWebContents()
      .find((wc) => wc.id !== shell.id && wc.getURL().startsWith('http://127.0.0.1:'));
    return {
      shell: shell.getLastWebPreferences(),
      remote: remote.getLastWebPreferences(),
      pageApi: await remote.executeJavaScript(
        '({bridge:typeof window.studyMate,require:typeof require,writes:window.controlWrites,time:document.querySelector("video").currentTime})',
      ),
    };
  });
  assert.equal(policy.remote.nodeIntegration, false);
  assert.equal(policy.remote.contextIsolation, true);
  assert.equal(policy.remote.sandbox, true);
  assert.equal(policy.pageApi.bridge, 'undefined');
  assert.equal(policy.pageApi.require, 'undefined');
  assert.deepEqual(policy.pageApi.writes, { seek: 0, pause: 0, rate: 0, volume: 0 });
  findings.checks.push('真实网页视频帧和字幕到达时间轴；页面无文件API；播放器控制写入为零');
  const taskId = await page.evaluate(() => window.studyMate.captureContext());
  await page.evaluate((url) => window.studyMate.openWeb(url), origin + '/b');
  const after = await waitForState(
    (state) =>
      state.tasks.find((task) => task.id === taskId)?.status === 'succeeded' &&
      state.context?.frames.length > 0,
  );
  assert.equal(after.context.anchor.sourceId, before.activeBinding.sourceId);
  assert.notEqual(after.context.anchor.sourceId, after.activeBinding.sourceId);
  assert.match(after.context.subtitles[0].text, /课程A/);
  assert.ok(after.context.frames[0].data.startsWith('data:image/webp;base64,'));
  findings.checks.push('发问后切到B来源，冻结上下文仍属于A且返回实际像素');
  await page.getByText('已冻结本次上下文', { exact: true }).waitFor();
  await page.locator('.context-result img').first().waitFor();
  await screenshot('04-learning-context');
  const sourceView = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.find(
      (child) => child.webContents && child.webContents.id !== window.webContents.id,
    );
    return {
      bounds: view.getBounds(),
      visible: view.getVisible(),
      pixels: (await view.webContents.capturePage()).toPNG().toString('base64'),
    };
  });
  const surface = await page.locator('.browser-surface').boundingBox();
  assert.equal(sourceView.visible, true);
  for (const key of ['x', 'y', 'width', 'height'])
    assert.ok(Math.abs(sourceView.bounds[key] - Math.round(surface[key])) <= 1);
  const viewImage = path.join(artifacts, '06-webview-content.png');
  await fs.writeFile(viewImage, Buffer.from(sourceView.pixels, 'base64'));
  findings.screenshots.push(viewImage);
  findings.checks.push('原生网页视图实际位置匹配阅读区域，网页内容独立截图留证');
  await page.getByRole('button', { name: '使用说明', exact: true }).click();
  await page.getByRole('dialog', { name: '开始使用', exact: true }).waitFor();
  const hiddenForModal = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
  );
  assert.equal(hiddenForModal, true);
  await screenshot('05-help');
  findings.checks.push('模态说明时隐藏网页原生视图，避免遮挡');
  assert.deepEqual(findings.pageErrors, []);
  await application.close();
  application = await _electron.launch({ executablePath, args: [root], env, timeout: 30000 });
  page = await application.firstWindow();
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  const restored = await page.evaluate(() => window.studyMate.state());
  assert.equal(restored.activeBinding, null);
  assert.ok(restored.sources.length >= 2);
  assert.match(await fs.readFile(path.join(initial.vaultPath, savedName), 'utf8'), /外部编辑器新增/);
  const archivedRoot = path.join(dataDir, 'evidence', before.activeBinding.sourceId, 'videos');
  const archivedSessions = await fs.readdir(archivedRoot);
  assert.ok(
    (await fs.readdir(path.join(archivedRoot, archivedSessions[0], 'preview'))).some((name) =>
      name.endsWith('.webp'),
    ),
  );
  findings.checks.push('原生应用重启后笔记、来源、像素归档保留；不冒充实时连接');
  findings.passed = true;
} catch (error) {
  findings.error = error.stack || String(error);
  if (application && page) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  if (application)
    await application
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
  if (application)
    await application.close().catch((error) => {
      findings.closeError = String(error);
    });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await devServer?.close();
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
}
