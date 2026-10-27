import { _electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = process.cwd();
const packed = process.argv.includes('--packed');
const packedExecutable =
  process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.10.0/win-unpacked/Study Mate.exe');
const development = process.argv.includes('--dev');
const dataDir = path.join(root, '.cache', 'media-smoke-' + Date.now());
const artifacts = path.join(
  root,
  'artifacts',
  packed ? 'media-packed' : development ? 'media-dev' : 'media-smoke',
);
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const findings = {
  passed: false,
  mode: packed ? 'standalone-exe' : development ? 'development-renderer' : 'production-build',
  checks: [],
  screenshots: [],
  pageErrors: [],
};
let app, page, videoFile, videoBytes, devServer;
const server = http.createServer((request, response) => {
  if (request.url === '/movie') {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), videoBytes.length - 1) : videoBytes.length - 1;
    response.writeHead(match ? 206 : 200, {
      'content-type': videoFile.endsWith('.mp4') ? 'video/mp4' : 'video/webm',
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(match ? { 'content-range': 'bytes ' + start + '-' + end + '/' + videoBytes.length } : {}),
    });
    response.end(videoBytes.subarray(start, end + 1));
  } else if (request.url === '/blocked') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>不可解析课程</title><video></video>');
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<title>网络视频 · 内置解析验收</title><body style="margin:0;background:#142b22;color:white;font:18px system-ui"><h3>NETWORK VIDEO · 原生解码验收</h3><video controls muted loop style="width:100%" src="/movie"></video><script>window.controlWrites={seek:0,pause:0,rate:0,volume:0};for(const key of ["currentTime","playbackRate","volume"]){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(v){window.controlWrites[key==="currentTime"?"seek":key==="playbackRate"?"rate":"volume"]++;d.set.call(this,v)}})}const p=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(){window.controlWrites.pause++;return p.call(this)};document.querySelector("video").play();</script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
async function stateUntil(predicate, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await page.evaluate(() => window.studyMate.state());
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('状态等待超时: ' + JSON.stringify({ tasks: state?.tasks, playback: state?.playback }));
}
async function shot(name) {
  const target = path.join(artifacts, name + '.png');
  await page.screenshot({ path: target, animations: 'disabled' });
  findings.screenshots.push(target);
}
async function selectPaths(filePaths, canceled = false) {
  await app.evaluate(
    ({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: input.canceled, filePaths: input.filePaths });
    },
    { filePaths, canceled },
  );
}
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
  if (packed) {
    env.PATH = 'C:\\Windows\\System32;C:\\Windows';
    for (const key of [
      'NODE_PATH',
      'NODE_OPTIONS',
      'FFMPEG_PATH',
      'FFPROBE_PATH',
      'YTDLP_PATH',
      'PYTHONHOME',
    ])
      delete env[key];
    findings.isolation =
      'PATH contains only Windows system directories; standalone executable launched without a project entry argument';
  }
  app = await _electron.launch({
    executablePath: packed ? packedExecutable : electronPath,
    cwd: packed ? path.dirname(packedExecutable) : root,
    args: packed ? [] : [root],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => findings.pageErrors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  findings.runtime = await app.evaluate(() => ({ versions: process.versions, executable: process.execPath }));
  await shot('01-home');
  const initial = await page.evaluate(() => window.studyMate.state());
  assert.ok(initial.dataDir.startsWith(dataDir));
  // MDN's CC0, normally indexed MP4 avoids MediaRecorder's fragmented-file seeking limitation.
  const fixtureUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
  const fixtureFile = path.join(root, '.cache/fixtures/flower.mp4');
  try {
    videoBytes = await fs.readFile(fixtureFile);
  } catch {
    const response = await fetch(fixtureUrl);
    if (!response.ok) throw new Error('测试样片下载失败');
    videoBytes = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(fixtureFile), { recursive: true });
    await fs.writeFile(fixtureFile, videoBytes);
  }
  videoFile = path.join(dataDir, '中文 视频 960x540.mp4');
  await fs.writeFile(videoFile, videoBytes);
  findings.fixture = { source: fixtureUrl, license: 'CC0', bytes: videoBytes.length };

  const externalMd = path.join(dataDir, '外部文档.md');
  await fs.writeFile(externalMd, '\uFEFF# 外部导入\r\n\r\n保留中文与换行。\r\n');
  await selectPaths([externalMd]);
  await page.getByRole('button', { name: '导入 Markdown', exact: true }).click();
  await page.getByRole('button', { name: '源码模式', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 笔记内容', exact: true }).waitFor();
  assert.equal(
    await fs.readFile(path.join(initial.vaultPath, '外部文档.md'), 'utf8'),
    await fs.readFile(externalMd, 'utf8'),
  );
  const imported = await page.evaluate(() => window.studyMate.importNotes());
  assert.deepEqual(imported.paths, ['外部文档 (2).md']);
  findings.checks.push('原生文件选择返回值接入真实外部MD导入、中文BOM/CRLF保留、同名不覆盖');
  await shot('02-imported-note');
  await app.evaluate(({ shell }) => {
    globalThis.__folderCalls = [];
    shell.openPath = async (target) => {
      globalThis.__folderCalls.push(target);
      return '';
    };
    shell.showItemInFolder = (target) => globalThis.__folderCalls.push(target);
  });
  await page.getByRole('button', { name: '打开笔记存储目录', exact: true }).click();
  await page.getByRole('button', { name: '在文件夹中显示笔记', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.__folderCalls), [
    initial.vaultPath,
    path.join(initial.vaultPath, '外部文档.md'),
  ]);
  findings.checks.push('打开知识库目录与定位当前笔记调用正确系统路径（系统shell调用替身）');
  const existingVault = path.join(dataDir, '已有知识库');
  await fs.mkdir(existingVault);
  await fs.writeFile(path.join(existingVault, '已有.md'), '# 原有知识库');
  await selectPaths([existingVault]);
  await page.getByRole('button', { name: '切换知识库', exact: true }).click();
  await stateUntil((state) => state.vaultPath === existingVault);
  assert.equal(await fs.readFile(path.join(existingVault, '已有.md'), 'utf8'), '# 原有知识库');
  findings.checks.push('已有Markdown目录切换成功，原笔记保留');
  await selectPaths([videoFile]);
  await page.getByRole('button', { name: /打开本地视频/ }).click();
  const localState = await stateUntil((state) => state.playback?.duration > 3);
  const localSource = localState.activeBinding.sourceId;
  await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const view = main.contentView.children.find(
      (child) => child.webContents && child.webContents.id !== main.webContents.id,
    );
    await view.webContents.executeJavaScript('document.querySelector("video").play()');
  });
  const probe = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const view = main.contentView.children.find(
        (child) => child.webContents && child.webContents.id !== main.webContents.id,
      );
      return {
        visible: view.getVisible(),
        ...(await view.webContents.executeJavaScript(
          '({time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused,rate:document.querySelector("video").playbackRate})',
        )),
      };
    });
  const before = await probe();
  assert.equal(before.visible, true);
  const localPixels = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const view = main.contentView.children.find(
      (child) => child.webContents && child.webContents.id !== main.webContents.id,
    );
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  });
  const localScreenshot = path.join(artifacts, '05-local-player.png');
  await fs.writeFile(localScreenshot, Buffer.from(localPixels, 'base64'));
  findings.screenshots.push(localScreenshot);
  const gateway = await app.evaluate(async ({ BrowserWindow, session }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const view = main.contentView.children.find(
      (child) => child.webContents && child.webContents.id !== main.webContents.id,
    );
    const asset = new URL(view.webContents.getURL()).searchParams.get('asset');
    const local = session.fromPartition('study-mate-local-player');
    const part = await local.fetch(asset, { headers: { Range: 'bytes=0-31' } });
    const tail = await local.fetch(asset, { headers: { Range: 'bytes=-16' } });
    const invalid = await local.fetch(asset, { headers: { Range: 'bytes=999999999-' } });
    let remoteError = '';
    try {
      await session.fromPartition('persist:study-mate-browser').fetch(asset);
    } catch (error) {
      remoteError = error.message;
    }
    return {
      partStatus: part.status,
      bytes: (await part.arrayBuffer()).byteLength,
      tailStatus: tail.status,
      tail: Buffer.from(await tail.arrayBuffer()).toString('base64'),
      invalidStatus: invalid.status,
      remoteError,
      bridge: await view.webContents.executeJavaScript(
        '({bridge:typeof window.studyMate,require:typeof require})',
      ),
    };
  });
  assert.equal(gateway.partStatus, 206);
  assert.equal(gateway.bytes, 32);
  assert.equal(gateway.tailStatus, 206);
  assert.equal(gateway.tail, videoBytes.subarray(-16).toString('base64'));
  assert.equal(gateway.invalidStatus, 416);
  assert.ok(gateway.remoteError);
  assert.deepEqual(gateway.bridge, { bridge: 'undefined', require: 'undefined' });
  findings.checks.push(
    '内置文件网关支持206/后缀Range/416，远程网页会话不能访问本地媒体协议，本地播放器无特权API',
  );
  await selectPaths([], true);
  await page.evaluate(() => window.studyMate.chooseVault());
  assert.equal((await probe()).visible, true);
  findings.checks.push('取消原生对话框后课程视图可见性恢复');
  const task = await page.evaluate(() => window.studyMate.analyze({ start: 0, end: 3, count: 3 }));
  const parsed = await stateUntil((state) =>
    ['failed', 'succeeded'].includes(state.tasks.find((t) => t.id === task)?.status),
  );
  assert.equal(
    parsed.tasks.find((t) => t.id === task).status,
    'succeeded',
    parsed.tasks.find((t) => t.id === task).error,
  );
  assert.equal(parsed.analysis.sourceId, localSource);
  assert.equal(parsed.analysis.frames.length, 3);
  assert.equal(parsed.analysis.width, 960);
  assert.equal(parsed.analysis.height, 540);
  assert.ok(parsed.analysis.duration >= 3);
  assert.ok(new Set(parsed.analysis.frames.map((frame) => frame.data)).size > 1);
  assert.ok(Math.abs(parsed.analysis.frames[2].timestamp - 3) < 0.15);
  findings.checks.push('真实本地MP4原生解码、指定范围定位、3张不同画面、960×540尺寸及D盘归档');
  const after = await probe();
  assert.equal(after.rate, before.rate);
  assert.equal(after.visible, true);
  await page.getByRole('button', { name: /查看解析结果/ }).click();
  await page.locator('.analysis-gallery img').first().waitFor();
  await shot('03-local-analysis');
  assert.equal(await page.locator('.analysis-gallery img').count(), 3);
  await page.locator('.nav-item').filter({ hasText: '课程浏览器' }).click();
  await page.evaluate((url) => window.studyMate.openWeb(url), origin + '/course');
  await stateUntil((state) => state.playback?.duration > 3 && state.activeBinding.sourceId !== localSource);
  const networkTask = await page.evaluate(() => window.studyMate.analyze({ start: 0.2, end: 3, count: 6 }));
  const network = await stateUntil((state) =>
    ['failed', 'succeeded'].includes(state.tasks.find((t) => t.id === networkTask)?.status),
  );
  assert.equal(
    network.tasks.find((t) => t.id === networkTask).status,
    'succeeded',
    network.tasks.find((t) => t.id === networkTask).error,
  );
  const counters = await app.evaluate(async ({ webContents }) => {
    const remote = webContents.getAllWebContents().find((wc) => wc.getURL().includes('/course'));
    return remote.executeJavaScript('window.controlWrites');
  });
  assert.deepEqual(counters, { seek: 0, pause: 0, rate: 0, volume: 0 });
  findings.checks.push('真实HTTP Range视频经内置代理抽取6帧，前台seek/pause/rate/volume写入全部为0');
  await page.getByRole('button', { name: /查看解析结果/ }).click();
  await shot('04-network-analysis');
  // Exercise the actual Bilibili resolver with a controlled platform response.
  // This is distinct from the separately recorded real-site result.
  await app.evaluate(({ session }, base64) => {
    const bytes = Buffer.from(base64, 'base64');
    globalThis.__biliRequests = [];
    session.fromPartition('persist:study-mate-browser').protocol.handle('https', (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.bilibili.com') {
        globalThis.__biliRequests.push(url.pathname + url.search);
        if (url.pathname.endsWith('/view'))
          return Response.json({
            code: 0,
            data: {
              pages: [
                { page: 1, cid: 101 },
                { page: 2, cid: 987654 },
              ],
            },
          });
        if (url.searchParams.get('cid') !== '987654')
          return Response.json({ code: -400, message: 'Wrong part cid' });
        return Response.json({
          code: 0,
          data: {
            dash: {
              video: [
                { codecid: 7, baseUrl: 'https://fixture.bilivideo.com/movie.mp4', width: 960, height: 540 },
              ],
            },
          },
        });
      }
      if (url.hostname === 'fixture.bilivideo.com') {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        return new Response(bytes.subarray(start, end + 1), {
          status: match ? 206 : 200,
          headers: {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            ...(match ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {}),
          },
        });
      }
      if (url.hostname === 'www.bilibili.com')
        return new Response('<!doctype html><title>B站分P解析 · 受控接口验收</title><h1>受控页面</h1>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      return new Response(null, { status: 403 });
    });
  }, videoBytes.toString('base64'));
  await page.evaluate(() => window.studyMate.openWeb('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2'));
  const biliTask = await page.evaluate(() => window.studyMate.analyze({ start: 0, end: 3, count: 3 }));
  const bili = await stateUntil((state) =>
    ['failed', 'succeeded'].includes(state.tasks.find((t) => t.id === biliTask)?.status),
  );
  assert.equal(
    bili.tasks.find((t) => t.id === biliTask).status,
    'succeeded',
    bili.tasks.find((t) => t.id === biliTask).error,
  );
  assert.ok((await app.evaluate(() => globalThis.__biliRequests)).some((url) => url.includes('cid=987654')));
  assert.equal(bili.sources.find((source) => source.id === bili.analysis.sourceId).partIndex, 2);
  await app.evaluate(({ session }) =>
    session.fromPartition('persist:study-mate-browser').protocol.unhandle('https'),
  );
  findings.checks.push('受控B站接口通过真实分P→cid→H.264 DASH→代理→原生解码全链路（不等于真实站点验收）');
  await page.evaluate((url) => window.studyMate.openWeb(url), origin + '/blocked');
  const failedTask = await page.evaluate(() => window.studyMate.analyze({ start: 0, end: null, count: 3 }));
  const failed = await stateUntil(
    (state) => state.tasks.find((t) => t.id === failedTask)?.status === 'failed',
  );
  assert.match(failed.tasks.find((t) => t.id === failedTask).error, /Blob|实时流|后台观看|后台课程/);
  findings.checks.push('不可独立解码来源显示具体失败原因，保留已有解析结果');
  await page.evaluate((id) => window.studyMate.openSource(id), localSource);
  const cancelled = await page.evaluate(async () => {
    const id = await window.studyMate.analyze({ start: 0, end: null, count: 12 });
    await window.studyMate.cancelTask(id);
    return id;
  });
  await stateUntil((state) => state.tasks.find((t) => t.id === cancelled)?.status === 'cancelled');
  const cleaned = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  assert.equal(cleaned, 1);
  findings.checks.push('原生解码任务可取消并清理隐藏窗口');
  await app.close();
  app = await _electron.launch({
    executablePath: packed ? packedExecutable : electronPath,
    cwd: packed ? path.dirname(packedExecutable) : root,
    args: packed ? [] : [root],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  const restored = await page.evaluate(() => window.studyMate.state());
  assert.equal(restored.activeBinding, null);
  assert.equal(restored.vaultPath, existingVault);
  assert.equal(restored.analysis.id, bili.analysis.id);
  assert.equal(restored.analysis.frames.length, 3);
  assert.ok(restored.analysis.frames.every((frame) => frame.data.startsWith('data:image/webp;base64,')));
  findings.checks.push('独立进程重启恢复所选知识库及完整解析画面，实时课程连接保持清空');
  assert.deepEqual(findings.pageErrors, []);
  findings.passed = true;
} catch (error) {
  findings.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) await shot('failure').catch(() => {});
} finally {
  if (app)
    await app.close().catch((error) => {
      findings.closeError = String(error);
    });
  await devServer?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
}
