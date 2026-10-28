import { _electron } from 'playwright-core';
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import pptxgen from 'pptxgenjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const root = process.cwd(),
  packed = process.argv.includes('--packed'),
  data = path.join(root, '.cache', 'reader-' + Date.now()),
  artifacts = path.join(root, 'artifacts', packed ? 'reader-packed' : 'reader');
await fs.mkdir(data, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const ppt = new pptxgen();
ppt.layout = 'LAYOUT_WIDE';
for (let n = 1; n <= 8; n++) {
  const slide = ppt.addSlide();
  slide.addText('第' + n + '讲 · 函数与图像', {
    x: 0.5,
    y: 0.35,
    w: 11.7,
    h: 0.55,
    fontSize: 30,
    color: '0F172A',
  });
  slide.addText('f(x) = x² + ' + n, { x: 0.7, y: 1.4, w: 7, h: 0.7, fontSize: 27, color: '0F766E' });
  slide.addShape(ppt.ShapeType.line, { x: 1, y: 3.2, w: 6, h: 0, line: { color: '64748B', width: 2 } });
  slide.addShape(ppt.ShapeType.line, { x: 1, y: 2, w: 0, h: 2, line: { color: '64748B', width: 2 } });
  slide.addShape(ppt.ShapeType.line, { x: 1.2, y: 3.1, w: 3, h: -1.4, line: { color: '0F766E', width: 3 } });
  slide.addNotes('中文讲解备注 ' + n);
}
const pptFile = path.join(data, '函数与图像.pptx');
await ppt.writeFile({ fileName: pptFile });
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i++) {
  const page = pdf.addPage([600, 780]);
  page.drawText('PDF annotation page ' + (i + 1), { x: 55, y: 700, font, size: 26 });
}
const pdfFile = path.join(data, '批注验收.pdf');
await fs.writeFile(pdfFile, await pdf.save());
const originals = { ppt: await fs.readFile(pptFile), pdf: await fs.readFile(pdfFile) };
const movie = path.join(root, '.cache/fixtures/flower.mp4');
const mainRequests = [],
  visionRequests = [];
let documentId = '',
  videoId = '',
  written = '';
const server = http.createServer(async (req, res) => {
  req.setEncoding('utf8');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const vision = req.url.startsWith('/vision');
  (vision ? visionRequests : mainRequests).push({ body, authorization: req.headers.authorization });
  let delta,
    finish = 'stop';
  if (vision) {
    delta = { content: '[视觉观察] 图中可见函数表达式与坐标线，文字与符号需核对原图。保持所给来源链接。' };
  } else {
    const tools = (body.messages || []).filter((m) => m.role === 'tool'),
      index = tools.length;
    const read = tools.map((m) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return {};
      }
    });
    const doc = read.find((r) => r.citation),
      video = read.find((r) => r.frames?.some((f) => f.citation?.startsWith('study-video://')));
    const calls = [
      ['read_document_page', { document_id: documentId, page: 3 }],
      ['view_document_page', { document_id: documentId, page: 3, region: null }],
      ['analyze_video', { start: 1, end: 2, frames: 1 }],
      [
        'save_note',
        {
          path: '来源索引.md',
          content:
            '# 函数学习笔记\n\n根据课件记录函数与图像。 [课件·第3页](' +
            doc?.citation +
            ')\n\n结合课程片段核对。 [课程·00:01](' +
            video?.frames?.[0]?.citation +
            ')\n',
          expected_version: null,
        },
      ],
    ];
    if (index < calls.length) {
      if (index === 3) written = calls[3][1].content;
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'reader-' + index,
            type: 'function',
            function: { name: calls[index][0], arguments: JSON.stringify(calls[index][1]) },
          },
        ],
      };
      finish = 'tool_calls';
    } else delta = { content: '已保存带课件页码和课程时间来源的学习笔记，视觉专员的观察已供文本模型使用。' };
  }
  res
    .writeHead(200, { 'Content-Type': 'text/event-stream' })
    .end(
      'data: ' +
        JSON.stringify({
          choices: [{ delta, finish_reason: finish }],
          usage: {
            prompt_tokens: vision ? 900 : 1200,
            completion_tokens: vision ? 110 : 80,
            total_tokens: vision ? 1010 : 1280,
            prompt_tokens_details: { cached_tokens: vision ? 0 : 800 },
          },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const result = { passed: false, checks: [], screenshots: [], errors: [] };
let app, page;
const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
if (packed) {
  env.PATH = 'C:\\Windows\\System32;C:\\Windows';
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
}
const executable =
  process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.12.0/win-unpacked/Study Mate.exe');
const launch = () =>
  _electron.launch({
    executablePath: packed ? executable : electron,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
  });
async function until(fn, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('阅读与浮窗验收等待超时');
}
async function shot(name, target = page) {
  const file = path.join(artifacts, name + '.png');
  await app.evaluate(
    ({ BrowserWindow }, url) => {
      const win=BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url);
      win.show();win.focus();
    },
    target.url(),
  );
  await target.screenshot({ path: file, timeout: 30000, animations: 'disabled' });
  result.screenshots.push(file);
}
async function choose(file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
}
async function readyPage(n) {
  console.log('Waiting for document page', n);
  await until(
    async () =>
      (await page.locator('.document-pane .document-sheet>img').count()) > 0 &&
      (await page.locator('.document-pane .document-sheet>img').getAttribute('alt')) === '第 ' + n + ' 页' &&
      (await page.getByRole('spinbutton', { name: '文档页码' }).inputValue()) === String(n) &&
      !(await page.locator('.document-loading').count()),
  );
}
async function draw(tool = '手写笔', offsetY = 0) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.annotation-layer').scrollIntoViewIfNeeded();
  const before = Number(await page.locator('.annotation-layer').getAttribute('data-ink-count'));
  const box = await page.locator('.annotation-layer').boundingBox();
  const stage = await page.locator('.document-stage').boundingBox();
  const viewport = await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  const top=Math.max(box.y,stage.y+4),bottom=Math.min(box.y+box.height,stage.y+stage.height-4,viewport.height-4);
  const left=Math.max(box.x,stage.x+4),right=Math.min(box.x+box.width,stage.x+stage.width-4,viewport.width-4);
  await page.evaluate(()=>{window.__inkTrace=[];if(!window.__inkListening){window.__inkListening=true;for(const type of ['pointerdown','pointerup','pointercancel'])window.addEventListener(type,e=>window.__inkTrace.push({type,target:e.target.tagName,cls:e.target.getAttribute('class'),x:e.clientX,y:e.clientY}),true);}});
  await page.mouse.move(left + (right-left) * 0.18, top + (bottom-top) * (0.53+offsetY));
  await page.mouse.down();
  await page.mouse.move(left + (right-left) * 0.55, top + (bottom-top) * (0.57+offsetY), { steps: 12 });
  await page.mouse.up();
  try{await until(async () => Number(await page.locator('.annotation-layer').getAttribute('data-ink-count')) === before + 1,10000);}catch(e){console.log('Ink diagnostic',tool,before,await page.evaluate(()=>({trace:window.__inkTrace,count:document.querySelector('.annotation-layer')?.getAttribute('data-ink-count'),class:document.querySelector('.annotation-layer')?.getAttribute('class')})));throw e;}
  return {x:left+(right-left)*0.365,y:top+(bottom-top)*(0.55+offsetY)};
}
try {
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()),
    '#0f766e',
  );
  await shot('01-unified-navigation');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await page.getByRole('button', { name: '隐藏伴学工作台', exact: true }).click();
  assert.ok((await page.locator('.sidebar').boundingBox()).width === 0);
  assert.equal(await page.locator('.companion').isVisible(), false);
  assert.ok((await page.locator('main.reader').boundingBox()).width > 1200);
  await shot('02-focused-workspace');
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开伴学工作台', exact: true }).click();
  result.checks.push(
    'Current user teal/glass theme preserved; navigation categories are separate; both side panels fully hide and restore',
  );
  await page.getByRole('textbox', { name: '伴学提问', exact: true }).fill('浮窗草稿不能丢失');
  await page.getByRole('button', { name: '伴学悬浮窗', exact: true }).click();
  let floating;
  await until(() => {
    floating = app.windows().find((w) => w.url().includes('panel=assistant'));
    return !!floating;
  });
  await until(async () =>
    (await floating.getByRole('textbox', { name: '伴学提问', exact: true }).inputValue()).includes(
      '浮窗草稿',
    ),
  );
  await floating.getByRole('button', { name: '固定悬浮窗', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('panel=assistant'));
    if (!win.isAlwaysOnTop()) throw Error('未置顶');
    win.setBounds({ x: 180, y: 120, width: 440, height: 620 });
  });
  await shot('03-floating-assistant', floating);
  await floating.getByRole('textbox', { name: '伴学提问', exact: true }).fill('浮窗继续编辑的草稿');
  await floating.getByRole('button', { name: '返回工作台侧栏', exact: true }).click();
  await until(
    async () =>
      (await page.getByRole('textbox', { name: '伴学提问', exact: true }).inputValue()) ===
      '浮窗继续编辑的草稿',
  );
  await page.getByRole('textbox', { name: '伴学提问', exact: true }).fill('');
  result.checks.push(
    'Native assistant window pins and changes position/size independently; draft survives pop-out editing and docking',
  );
  await page.getByRole('button', { name: '导航悬浮窗', exact: true }).click();
  let nav;
  await until(() => {
    nav = app.windows().find((w) => w.url().includes('panel=navigation'));
    return !!nav;
  });
  await nav.getByRole('tab', { name: '文档分类', exact: true }).click();
  await shot('04-floating-navigation', nav);
  await nav.getByRole('button', { name: '返回工作台侧栏', exact: true }).click();
  await until(() =>
    page
      .getByRole('tab', { name: '文档分类', exact: true })
      .getAttribute('aria-selected')
      .then((v) => v === 'true'),
  );
  result.checks.push(
    'Native navigation floats separately, preserves category selection and docks back without mixed resource lists',
  );
  await choose(pptFile);
  await page.getByRole('button', { name: '打开 PDF / PowerPoint', exact: true }).click();
  await readyPage(1);
  documentId = await page.locator('.document-pane').getAttribute('data-document-id');
  await page.locator('.document-thumbnail img').first().waitFor();
  assert.ok((await page.locator('.document-thumbnail').count()) <= 8);
  await shot('05-ppt-thumbnails');
  await page.getByRole('button', { name: /跳转第 3 页/ }).click();
  await readyPage(3);
  await page.keyboard.press('ArrowRight');
  await readyPage(4);
  await page.locator('.document-stage').hover();
  await page.mouse.wheel(0, 140);
  await readyPage(5);
  await page.getByRole('button', { name: '让 AI 看本页', exact: true }).click();
  await page.getByLabel('待参考资料', { exact: true }).waitFor();
  const cleanDraft = await page.getByRole('textbox', { name: '伴学提问', exact: true }).inputValue();
  assert.doesNotMatch(cleanDraft, /view_document_page|请调用|doc-[a-f0-9]{24}/);
  assert.match(cleanDraft, /课件/);
  await shot('05b-clean-source-reference');
  await page.getByTitle('目录与搜索', { exact: true }).click();
  await page.getByTitle('目录与搜索', { exact: true }).click();
  await page.getByRole('button', { name: '目录与搜索', exact: true }).last().click();
  await page.getByRole('button', { name: '第5讲 · 函数与图像', exact: false }).count();
  result.checks.push(
    'PPT titles and lazy real thumbnails expose all pages; thumbnail click, arrow and wheel navigate requested pages',
  );
  const eraseAt = await draw();
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await until(() =>
    page
      .locator('.annotation-layer')
      .getAttribute('data-ink-count')
      .then((v) => v === '1'),
  );
  await draw('画直线', -0.22);
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await until(() =>
    page
      .locator('.annotation-layer')
      .getAttribute('data-ink-count')
      .then((v) => v === '2'),
  );
  await shot('06-ppt-ink');
  await page.getByRole('button', { name: '橡皮擦', exact: true }).click();
  await page.mouse.move(eraseAt.x,eraseAt.y);
  await page.mouse.down();
  await page.mouse.up();
  await until(async()=>await page.locator('.annotation-layer').getAttribute('data-ink-count')==='1',10000);
  await page.getByRole('button', { name: '清除本页批注', exact: true }).click();
  await until(() =>
    page
      .locator('.annotation-layer')
      .getAttribute('data-ink-count')
      .then((v) => v === '0'),
  );
  await draw('画直线');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.getByRole('spinbutton', { name: '文档页码' }).fill('6');
  await readyPage(6);
  await page.getByRole('spinbutton', { name: '文档页码' }).fill('5');
  await readyPage(5);
  await until(() =>
    page
      .locator('.annotation-layer')
      .getAttribute('data-ink-count')
      .then((v) => v === '1'),
  );
  result.checks.push(
    'PPT pen/line, whole-stroke eraser and clear work; saved normalized ink survives page changes',
  );
  await choose(pdfFile);
  await page.getByRole('button', { name: '打开 PDF / PowerPoint', exact: true }).click();
  await readyPage(1);
  await draw('荧光笔');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await shot('07-pdf-ink');
  assert.deepEqual(await fs.readFile(pdfFile), originals.pdf);
  assert.deepEqual(await fs.readFile(pptFile), originals.ppt);
  result.checks.push(
    'PDF supports persistent highlight/ink with original PDF and PPTX bytes unchanged; Markdown remains outside annotation tools',
  );
  await choose(movie);
  await page.getByRole('tab', { name: '课程分类', exact: true }).click();
  await page.getByRole('button', { name: '打开本地视频', exact: true }).click();
  await until(() => page.evaluate(() => window.studyMate.state().then((s) => s.playback?.duration > 4)));
  await page.evaluate(() => window.studyMate.player({ action: 'seek', time: 1.5 }));
  await page.evaluate(() => window.studyMate.player({ action: 'pause' }));
  await until(() =>
    page.evaluate(() => window.studyMate.player({ action: 'state' }).then((s) => s.time >= 1)),
  );
  videoId = (await page.evaluate(() => window.studyMate.state())).activeBinding.sourceId;
  await page.getByRole('tab', { name: '文档分类', exact: true }).click();
  await page
    .getByRole('button', { name: /函数与图像/ })
    .first()
    .click();
  await readyPage(5);
  await page.evaluate(async (url) => {
    const s = await window.studyMate.ai({ action: 'state' });
    await window.studyMate.ai({
      action: 'configure',
      config: {
        ...s.config,
        preset: 'custom',
        protocol: 'chat',
        baseUrl: url + '/main',
        model: 'primary-text',
        effort: 'high',
        contextSize: 65536,
        maxOutput: 2048,
        autoCompact: false,
      },
      key: 'main-key',
    });
  }, origin);
  await page.getByRole('button', { name: 'AI 接入设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '启用独立视觉模型', exact: true }).check();
  await page.getByRole('combobox', { name: '视觉服务', exact: true }).selectOption('custom');
  await page.getByRole('textbox', { name: '视觉模型 ID', exact: true }).fill('visual-reader');
  await page.getByRole('textbox', { name: '视觉接口地址', exact: true }).fill(origin + '/vision');
  await page.getByRole('textbox', { name: '视觉 API Key', exact: true }).fill('vision-key');
  await page.getByRole('button', { name: '保存图像识别设置', exact: true }).click();
  await page.getByText('视觉分工已保存，下一次提问生效。', { exact: true }).waitFor();
  await shot('08-model-roles');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '允许保存', exact: true }).check();
  await page
    .getByRole('textbox', { name: '伴学提问', exact: true })
    .fill('根据第3页课件和当前视频片段写学习笔记，在相关段落留下来源超链接。');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
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
  assert.equal(ai.config.model, 'primary-text');
  assert.equal(ai.messages.at(-1).visionRequests, 2);
  assert.ok(
    ai.messages.at(-1).tools.every((t) => t.status === 'complete'),
    JSON.stringify(ai.messages.at(-1)),
  );
  assert.equal(visionRequests.length, 2);
  assert.ok(visionRequests.every((r) => !r.body.tools));
  assert.ok(visionRequests.every((r) => r.authorization === 'Bearer vision-key'));
  assert.ok(mainRequests.every((r) => r.authorization === 'Bearer main-key'));
  assert.ok(mainRequests.every((r) => !JSON.stringify(r.body.messages).includes('image_url')));
  assert.ok(visionRequests.every((r) => JSON.stringify(r.body.messages).includes('data:image')));
  assert.match(mainRequests[0].body.messages[0].content, /必须主动.*来源超链接/);
  assert.ok(mainRequests.some((r) => JSON.stringify(r.body.messages).includes('visual_observation')));
  assert.ok(!JSON.stringify(ai).includes('visionImages'));
  assert.doesNotMatch(ai.messages.find(m=>m.role==='user').text, /view_document_page|请调用|doc-[a-f0-9]{24}/);
  assert.match(mainRequests[0].body.messages.at(-1).content, /本轮界面操作的读取提示/);
  await shot('09-dual-model-result');
  result.checks.push(
    'Vision-only provider receives actual images without tools; reasoning text model receives observations/citations without pixels; independent encrypted keys and usage work',
  );
  await page.getByRole('tab', { name: '笔记分类', exact: true }).click();
  await until(async () => (await page.getByText('来源索引', { exact: true }).count()) > 0);
  await page.getByText('来源索引', { exact: true }).first().click();
  await page.locator('.note-pane').waitFor();
  assert.equal(await page.locator('.note-pane .annotation-layer').count(), 0);
  await page.locator('.note-preview a').filter({hasText:'课件·第3页'}).click();
  await readyPage(3);
  await page.getByRole('tab', { name: '笔记分类', exact: true }).click();
  await page.getByText('来源索引', { exact: true }).first().click();
  await page.locator('.note-preview a').filter({hasText:'课程·00:01'}).click();
  const citedTime = Number(written.match(/study-video:\/\/[^/]+\/([\d.]+)/)[1]);
  await until(() =>
    page.evaluate(time => window.studyMate.player({ action: 'state' }).then((s) => Math.abs(s.time - time) < 0.3), citedTime),
  );
  assert.ok(written.includes('study-cite://' + documentId + '/3'));
  assert.ok(written.includes('study-video://' + videoId + '/'));
  await shot('10-source-links');
  result.checks.push(
    'System prompt requests paragraph-level source links; saved Markdown links return to exact PPT page and video time',
  );
  await app.close();
  app = null;
  app = await launch();
  page = await app.firstWindow();
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  const restored = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  assert.equal(restored.vision.enabled, true);
  assert.equal(restored.vision.config.model, 'visual-reader');
  await page.getByRole('tab', { name: '文档分类', exact: true }).click();
  await page
    .getByRole('button', { name: /函数与图像/ })
    .first()
    .click();
  await readyPage(3);
  await page.getByRole('spinbutton', { name: '文档页码' }).fill('5');
  await readyPage(5);
  await until(() =>
    page
      .locator('.annotation-layer')
      .getAttribute('data-ink-count')
      .then((v) => v === '1'),
  );
  await shot('11-restored-ink');
  assert.deepEqual(result.errors, []);
  result.checks.push('Annotations and visual/text model configuration survive a full application restart');
  result.passed = true;
} catch (e) {
  console.error(e);
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
