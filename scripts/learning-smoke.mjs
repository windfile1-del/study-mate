import { _electron } from 'playwright-core';
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
const root = process.cwd(),
  packed = process.argv.includes('--packed'),
  data = path.join(root, '.cache', 'learning-' + Date.now()),
  vault = path.join(data, 'vault'),
  large = path.join(data, 'large-vault'),
  artifacts = path.join(root, 'artifacts', packed ? 'learning-packed' : 'learning');
for (const p of [vault, large, artifacts]) await fs.mkdir(p, { recursive: true });
await fs.writeFile(
  path.join(vault, '系统.md'),
  '---\naliases: [动力学]\n---\n# 二阶闭环系统\n阻尼比很小时，系统响应会超过目标值形成较高的超调峰值；提高阻尼可减少超调。',
);
await fs.writeFile(
  path.join(vault, '烹饪.md'),
  '# 厨房\n蛋炒饭的烹饪步骤：切碎洋葱，加热炒锅，加入米饭与鸡蛋。',
);
await fs.writeFile(path.join(vault, '天气.md'), '# 天气\n昨天的天气非常晴朗，明天可能下雨。');
await fs.writeFile(path.join(vault, '引用.md'), '# 引用\n[[动力学]]\n[控制课程](系统.md)');
for (let n = 0; n < 5006; n += 150)
  await Promise.all(
    Array.from({ length: Math.min(150, 5006 - n) }, (_, j) =>
      fs.writeFile(
        path.join(large, `资料-${String(n + j).padStart(5, '0')}.md`),
        '# 归档\n这是普通的历史资料。',
      ),
    ),
  );
await fs.writeFile(
  path.join(large, '资料-05005.md'),
  '普通正文\n'.repeat(15000) + '\n范围之外的唯一传递函数证据',
);
const audioFile = path.join(root, '.cache/fixtures/jfk.wav');
try {
  await fs.access(audioFile);
} catch {
  await fs.mkdir(path.dirname(audioFile), { recursive: true });
  const r = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
  await fs.writeFile(audioFile, Buffer.from(await r.arrayBuffer()));
}
const wav = await fs.readFile(audioFile);
const server = http.createServer((req, res) => {
  if (req.url === '/speech.wav') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''),
      start = m ? +m[1] : 0,
      end = m && m[2] ? Math.min(+m[2], wav.length - 1) : wav.length - 1;
    res.writeHead(m ? 206 : 200, {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
    });
    res.end(wav.subarray(start, end + 1));
    return;
  }
  res
    .writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
    .end(
      '<title>无字幕口头讲解测试</title><h1>课程音轨</h1><video controls style="width:800px;height:450px" src="/speech.wav"></video>',
    );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const result = { passed: false, checks: [], screenshots: [], errors: [], performance: {} };
let app, page;
const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const executable =
  process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.12.0/win-unpacked/Study Mate.exe');
if (packed) {
  env.PATH = 'C:\\Windows\\System32;C:\\Windows';
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
}
const launch = () =>
  _electron.launch({
    executablePath: packed ? executable : electron,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
    timeout: 30000,
  });
async function until(fn, timeout = 120000) {
  const now = Date.now();
  while (Date.now() - now < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('等待条件超时');
}
async function shot(name) {
  const file = path.join(artifacts, name + '.png');
  await page.screenshot({ path: file, timeout: 30000 });
  result.screenshots.push(file);
}
async function choose(file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
}
try {
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await until(() => page.evaluate(() => window.studyMate.state().then((s) => s.knowledge.phase === 'ready')));
  // A real multilingual ONNX model, not a fixed embedding fixture.
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '识别与全库检索' });
  await panel.getByRole('button', { name: '全库检索', exact: true }).click();
  await panel.getByRole('button', { name: '建立语义索引', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate
        .state()
        .then((s) => s.knowledge.embedded === s.knowledge.chunks && s.knowledge.embedded > 0),
    ),
  );
  const semantic = await page.evaluate(() =>
    window.studyMate.knowledge({
      action: 'search',
      query: '怎样降低反馈装置响应时超过设定值的峰值',
      mode: 'semantic',
      limit: 4,
    }),
  );
  assert.equal(semantic[0].path, '系统.md');
  assert.ok(semantic[0].score > semantic.find((h) => h.path === '烹饪.md').score);
  const links = await page.evaluate(() =>
    window.studyMate.knowledge({ action: 'backlinks', path: '系统.md' }),
  );
  assert.equal(links.length, 2);
  await panel.getByRole('textbox', { name: '全库查询' }).fill('怎样降低反馈装置响应时超过设定值的峰值');
  await panel.getByRole('combobox', { name: '检索方式' }).selectOption('semantic');
  await panel.getByRole('button', { name: '搜索', exact: true }).click();
  await panel.locator('.knowledge-results button').first().waitFor();
  await shot('01-semantic-index');
  result.checks.push(
    'Real multilingual embeddings rank related Chinese concepts over unrelated cooking/weather; aliases and Markdown backlinks resolve',
  );
  await panel.getByRole('button', { name: '返回学习', exact: true }).click();
  // An actual scanned PDF with bitmap-only pages, including a blank low-confidence page.
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 600;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 1200, 600);
    ctx.fillStyle = '#243d2e';
    ctx.font = '54px Arial';
    ctx.fillText('CONTROL SYSTEM 2026', 70, 130);
    ctx.font = '52px Microsoft YaHei';
    ctx.fillText('自动控制原理 学习笔记', 70, 250);
    return c.toDataURL('image/png');
  });
  const pdf = await PDFDocument.create(),
    image = await pdf.embedPng(Buffer.from(png.split(',')[1], 'base64'));
  pdf.addPage([1200, 600]).drawImage(image, { x: 0, y: 0, width: 1200, height: 600 });
  pdf.addPage([1200, 600]);
  const file = path.join(data, '扫描课件.pdf');
  await fs.writeFile(file, await pdf.save());
  await choose(file);
  await page.getByRole('tab', { name: '文档分类', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF / PowerPoint', exact: true }).click();
  await page.locator('.document-sheet img').waitFor();
  await page.evaluate(async()=>{const list=await window.studyMate.state();const doc=list.documents.find(d=>d.title==='扫描课件.pdf');await window.studyMate.recognition({action:'ocr-document',id:doc.id,page:Number(document.querySelector('[aria-label="文档页码"]').value)});});
  
  let ocr = (await page.evaluate(() => window.studyMate.recognition({ action: 'state' }))).ocr;
  assert.match(ocr.text, /CONTROL SYSTEM/);
  assert.match(ocr.text.replaceAll(' ', ''), /自动控制/);
  assert.equal(ocr.source.page, 1);
  assert.ok(ocr.source.citation.startsWith('study-cite://'));
  assert.ok(ocr.words.some((w) => w.width > 0 && w.height > 0));
  await shot('02-scan-ocr');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.locator('.document-sheet img[alt="第 2 页"]').waitFor();
  await page.evaluate(async()=>{const list=await window.studyMate.state();const doc=list.documents.find(d=>d.title==='扫描课件.pdf');await window.studyMate.recognition({action:'ocr-document',id:doc.id,page:Number(document.querySelector('[aria-label="文档页码"]').value)});});
  
  ocr = (await page.evaluate(() => window.studyMate.recognition({ action: 'state' }))).ocr;
  assert.equal(ocr.lowConfidence, true);
  assert.ok(ocr.confidence<70);
  await shot('03-low-confidence');
  result.checks.push(
    'Optional legacy Chinese/English print OCR API preserves words/bounds/citation and blank-page low confidence; default reader uses original images',
  );
  // Capture a selected course tab at 2x, then pause/seek/rate-change. No system or microphone capture.
  await page.evaluate((url) => window.studyMate.openWeb(url), 'http://127.0.0.1:' + server.address().port);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.studyMate.player({ action: 'rate', rate: 2 }));
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  await page.getByRole('combobox', { name: '转写语言' }).selectOption('english');
  await page.getByRole('button', { name: '开始课程采音', exact: true }).click();
  await until(() =>
    page.evaluate(() => window.studyMate.recognition({ action: 'state' }).then((s) => s.capturing)),
  );
  assert.equal((await page.evaluate(() => window.studyMate.player({ action: 'state' }))).rate, 2);
  await page.evaluate(() => window.studyMate.player({ action: 'play' }));
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.studyMate.player({ action: 'pause' }));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.studyMate.player({ action: 'seek', time: 8 }));
  await page.evaluate(() => window.studyMate.player({ action: 'rate', rate: 1 }));
  await page.evaluate(() => window.studyMate.player({ action: 'play' }));
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: '停止采音', exact: true }).click();
  await until(
    () =>
      page.evaluate(() =>
        window.studyMate.recognition({ action: 'state' }).then((s) => !s.capturing && !s.queued && !s.processing),
      ),
    180000,
  );
  const recognition = await page.evaluate(() => window.studyMate.recognition({ action: 'state' }));
  assert.equal(recognition.capturing, false);
  assert.ok(recognition.segments.length >= 2, recognition.message);
  assert.ok(new Set(recognition.segments.map((s) => s.epoch)).size >= 2);
  assert.ok(
    recognition.segments.some(
      (s) => s.start < 2 && s.end <= 11.8 && !s.gap && /country|Americans/i.test(s.text),
    ),
  );
  assert.ok(recognition.segments.some((s) => s.start >= 7.5 && s.end <= 11.8));
  assert.ok(
    recognition.segments.every(
      (s) => s.confidence === null && s.warning && s.citation.startsWith('study-video://'),
    ),
  );
  await shot('04-audio-transcript');
  result.checks.push(
    'Real course-tab PCM capture and local ASR preserve separate 2x/seek epochs, map timestamps to original video, stop cleanly and expose source/uncertainty',
  );
  await page.getByRole('button', { name: '返回学习', exact: true }).click();
  // The full-text database is independent from the 5000-row UI tree and 64KB historical search cache.
  await choose(large);
  const started = Date.now();
  await page.getByRole('tab', { name: '笔记分类', exact: true }).click();
  await page.getByRole('button', { name: '切换知识库', exact: true }).click();
  await page.evaluate(() => {
    window.__learningGaps = [];
    let last = performance.now();
    window.__learningHeartbeat = setInterval(() => {
      const now = performance.now();
      window.__learningGaps.push(now - last);
      last = now;
    }, 50);
  });
  await until(
    () =>
      page.evaluate(() =>
        window.studyMate.state().then((s) => s.knowledge.phase === 'ready' && s.knowledge.files === 5006),
      ),
    180000,
  );
  result.performance.full5006IndexMs = Date.now() - started;
  const full = await page.evaluate(() =>
    window.studyMate.knowledge({ action: 'search', query: '唯一传递函数证据', mode: 'keyword', limit: 10 }),
  );
  assert.equal(full[0].path, '资料-05005.md');
  assert.ok(full[0].lineStart > 10000);
  await fs.appendFile(path.join(large, '资料-05004.md'), '\n外部增量更新的新证据');
  await until(() =>
    page.evaluate(() =>
      window.studyMate
        .knowledge({ action: 'search', query: '外部增量更新的新证据', mode: 'keyword', limit: 10 })
        .then((h) => h.some((x) => x.path === '资料-05004.md')),
    ),
  );
  result.performance.uiHeartbeatMaxMs = await page.evaluate(() => {
    clearInterval(window.__learningHeartbeat);
    return Math.max(...window.__learningGaps);
  });
  assert.ok(result.performance.uiHeartbeatMaxMs < 1000, 'Indexing blocked the reader');
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  await page.getByRole('button', { name: '全库检索', exact: true }).click();
  await page.getByRole('textbox', { name: '全库查询' }).fill('唯一传递函数证据');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.knowledge-results button').first().waitFor();
  await shot('05-full-vault-index');
  result.checks.push(
    '5006-note persistent full-text scan finds late-file and post-64KB evidence, external writes update index, renderer heartbeat stays responsive',
  );
  await page.getByRole('button', { name: '返回学习', exact: true }).click();
  const expected = 5006;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await until(() =>
    page.evaluate((n) => window.studyMate.state().then((s) => s.knowledge.files === n), expected),
  );
  const persisted = await page.evaluate(() =>
    window.studyMate.knowledge({ action: 'search', query: '唯一传递函数证据', mode: 'keyword', limit: 10 }),
  );
  assert.equal(persisted[0].path, '资料-05005.md');
  result.checks.push('SQLite FTS and source metadata persist across full application restart');
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (e) {
  result.error = e.stack || String(e);
  process.exitCode = 1;
  if (page) await shot('failure').catch(() => {});
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
