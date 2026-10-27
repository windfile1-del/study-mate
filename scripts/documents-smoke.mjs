import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pptxgen from 'pptxgenjs';
import * as CFB from 'cfb';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.cwd(),
  packed = process.argv.includes('--packed'),
  data = path.join(root, '.cache', 'documents-' + Date.now()),
  fixtures = path.join(data, 'fixtures'),
  artifacts = path.join(root, 'artifacts', packed ? 'documents-packed' : 'documents');
await fs.mkdir(fixtures, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const protectedFile = path.join(root, '.cache/fixtures/password-issue3371.pdf');
await fs.mkdir(path.dirname(protectedFile), { recursive: true });
try {
  await fs.access(protectedFile);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  const response = await fetch(
    'https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/issue3371.pdf',
  );
  if (!response.ok) throw Error('无法下载PDF.js密码回归样例');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1_000_000) throw Error('PDF密码测试样例过大');
  await fs.writeFile(protectedFile, bytes);
}
assert.equal(
  createHash('sha256')
    .update(await fs.readFile(protectedFile))
    .digest('hex'),
  '0c3fb45d9b61ea762b4b3298c8c47e5375e83d151d356d87d740bcb85d953473',
);
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) {
  const p = pdf.addPage([720, 960]);
  p.drawText('Study Mate / Document ' + i, { x: 64, y: 860, size: 32, font, color: rgb(0.2, 0.35, 0.22) });
  p.drawText('PAGE_' + i + '_PRIVATE_EVIDENCE', { x: 64, y: 810, size: 18, font });
  p.drawRectangle({ x: 100, y: 400, width: 400, height: 240, color: rgb(0.7, 0.85, 0.64) });
  p.drawText('Diagram ' + i, { x: 220, y: 510, size: 24, font });
}
// An actual scanned page containing only a bitmap.
const bitmap = await pdf.embedPng(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);
pdf.addPage([720, 960]).drawImage(bitmap, { x: 100, y: 100, width: 400, height: 400 });
const pdfFile = path.join(fixtures, '课程讲义.pdf');
await fs.writeFile(pdfFile, await pdf.save());
const original = await fs.readFile(pdfFile);
const ppt = new pptxgen();
ppt.layout = 'LAYOUT_WIDE';
ppt.author = 'Study Mate fixture';
for (let i = 1; i <= 3; i++) {
  const slide = ppt.addSlide();
  slide.background = { color: 'F6F8F1' };
  slide.addText('控制系统 · 第' + i + '讲', {
    x: 0.7,
    y: 0.5,
    w: 11,
    h: 0.6,
    fontFace: 'Microsoft YaHei',
    fontSize: 30,
    color: '334B3B',
  });
  slide.addText('SLIDE_' + i + '_PRIVATE_EVIDENCE', { x: 0.7, y: 1.5, w: 10, h: 0.5, fontSize: 20 });
  slide.addTable(
    [
      ['频率', '增益'],
      ['10 Hz', '20 dB'],
    ],
    { x: 0.7, y: 2.6, w: 5, h: 1.4, border: { color: 'CAD7C0', pt: 1 }, fontSize: 18 },
  );
  slide.addShape(ppt.ShapeType.rect, {
    x: 7,
    y: 2.6,
    w: 4,
    h: 2,
    fill: { color: 'A8C695' },
    line: { color: '729554' },
  });
  slide.addNotes('第' + i + '张演讲者备注 SPEAKER_' + i);
}
const pptFile = path.join(fixtures, '控制系统课件.pptx');
await ppt.writeFile({ fileName: pptFile });
const record = (type, bytes, header = 0) => {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(header);
  h.writeUInt16LE(type, 2);
  h.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([h, bytes]);
};
const binary = CFB.utils.cfb_new();
CFB.utils.cfb_add(
  binary,
  'PowerPoint Document',
  record(
    4080,
    Buffer.concat([
      record(1011, Buffer.alloc(16)),
      record(4000, Buffer.from('旧版课件\r简化文字阅读', 'utf16le')),
    ]),
    15,
  ),
);
const legacyFile = path.join(fixtures, '旧版课件.ppt');
await fs.writeFile(legacyFile, Buffer.from(CFB.write(binary, { type: 'buffer' })));
const requests = [];
let pendingResolve, releaseFirst;
const server = http.createServer(async (req, res) => {
  let body = '';
  req.setEncoding('utf8');
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  requests.push(input);
  if (requests.length === 1)
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
  const toolMessages = input.messages.filter((m) => m.role === 'tool');
  const delta =
    toolMessages.length >= 2
      ? { content: '已按页理解资料。[讲义·第2页](' + pendingResolve.id.replace(/^/, 'study-cite://') + '/2)' }
      : {
          tool_calls: [
            {
              index: 0,
              id: 'doc-read',
              type: 'function',
              function: {
                name: 'read_document_page',
                arguments: JSON.stringify({ document_id: null, page: null }),
              },
            },
            {
              index: 1,
              id: 'doc-view',
              type: 'function',
              function: {
                name: 'view_document_page',
                arguments: JSON.stringify({ document_id: null, page: 2, region: null }),
              },
            },
          ],
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [{ delta, finish_reason: toolMessages.length >= 2 ? 'stop' : 'tool_calls' }],
        usage: {
          prompt_tokens: 3200,
          completion_tokens: 40,
          total_tokens: 3240,
          prompt_tokens_details: { cached_tokens: 2500 },
        },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const result = { passed: false, checks: [], screenshots: [], errors: [] };
let app, page;
async function until(fn, timeout = 45000) {
  const begin = Date.now();
  while (Date.now() - begin < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('等待条件超时');
}
async function shot(name) {
  await page.waitForTimeout(350);
  await until(() =>
    page
      .locator('.document-loading')
      .count()
      .then((n) => n === 0),
  );
  await page.waitForTimeout(200);
  const file = path.join(artifacts, name + '.png');
  await page.screenshot({ path: file });
  result.screenshots.push(file);
}
async function open(file) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, file);
  await page.getByRole('button', { name: '打开 PDF / PowerPoint', exact: true }).click();
  await page
    .locator('main .document-title strong')
    .filter({ hasText: path.basename(file) })
    .waitFor();
  await until(() =>
    page
      .locator('main .document-sheet')
      .count()
      .then((n) => n === 1),
  );
  await until(() =>
    page
      .locator('main .document-loading')
      .count()
      .then((n) => n === 0),
  );
  return page.evaluate(
    (title) => window.studyMate.state().then((s) => s.documents.find((d) => d.title === title)),
    path.basename(file),
  );
}
try {
  const executable =
      process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.10.0/win-unpacked/Study Mate.exe'),
    env = {
      ...process.env,
      STUDYMATE_DATA_DIR: data,
      STUDYMATE_SMOKE: '1',
      TEMP: path.join(root, '.cache/temp'),
      TMP: path.join(root, '.cache/temp'),
    };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (packed) {
    env.PATH = 'C:\\Windows\\System32;C:\\Windows';
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
  }
  app = await _electron.launch({
    executablePath: packed ? executable : electronPath,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
    timeout: 30000,
  });
  app.on('window', (w) =>
    w.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        console.log('DOCUMENT ENGINE', m.text());
        if (m.text().includes('Error rendering shape')) result.errors.push(m.text());
      }
    }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  const doc = await open(pdfFile);
  assert.equal(doc.pages, 4);
  pendingResolve = doc;
  const read = await page.evaluate(
    (id) => window.studyMate.document({ action: 'page', id, page: 2, width: 1000, image: true }),
    doc.id,
  );
  assert.match(read.page.text, /PAGE_2_PRIVATE/);
  assert.doesNotMatch(read.page.text, /PAGE_1_PRIVATE/);
  assert.match(read.page.image, /^data:image\/webp/);
  assert.ok(read.page.blocks.length > 0);
  const crop = await page.evaluate(
    (id) =>
      window.studyMate.document({
        action: 'page',
        id,
        page: 2,
        width: 1000,
        image: true,
        region: { x: 0.1, y: 0.25, width: 0.5, height: 0.5 },
      }),
    doc.id,
  );
  assert.equal(crop.page.width, 500);
  assert.ok(crop.page.height < read.page.height);
  assert.notEqual(crop.page.image, read.page.image);
  const scan = await page.evaluate(
    (id) => window.studyMate.document({ action: 'page', id, page: 4, width: 600, image: true }),
    doc.id,
  );
  assert.equal(scan.page.text, '');
  assert.match(scan.page.gaps.join(''), /OCR/);
  result.checks.push('PDF worker raster, text coordinates, scanned-page gap and real region crop');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await until(() =>
    page
      .locator('main .document-sheet img')
      .getAttribute('alt')
      .then((v) => v === '第 2 页'),
  );
  await shot('01-pdf');
  const hits = await page.evaluate(
    (id) => window.studyMate.document({ action: 'search', id, query: 'PAGE_3_PRIVATE', start: 1, limit: 4 }),
    doc.id,
  );
  assert.equal(hits.hits[0].page, 3);
  result.checks.push('PDF bounded page search and navigation');
  const presentation = await open(pptFile);
  assert.equal(presentation.pages, 3);
  const slide = await page.evaluate(
    (id) => window.studyMate.document({ action: 'page', id, page: 2, width: 1200, image: true }),
    presentation.id,
  );
  assert.match(slide.page.text, /SLIDE_2_PRIVATE/);
  assert.match(slide.page.notes, /SPEAKER_2/);
  assert.match(slide.page.text, /频率/);
  assert.match(slide.page.image, /^data:image\/webp/);
  const pixels = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0,
      green = 0;
    for (let y = 10; y < c.height; y++)
      for (let x = 20; x < c.width - 20; x++) {
        const at = (y * c.width + x) * 4;
        if (
          y < c.height * 0.3 &&
          data[at] < 120 &&
          data[at + 1] < 150 &&
          data[at + 2] < 120 &&
          data[at + 1] > data[at] + 5
        )
          dark++;
        if (
          x > c.width * 0.5 &&
          y > c.height * 0.3 &&
          y < c.height * 0.7 &&
          data[at + 1] > data[at] + 10 &&
          data[at + 1] > data[at + 2] + 10
        )
          green++;
      }
    return { dark, green };
  }, slide.page.image);
  assert.ok(pixels.dark > 500, 'Title text must render, not empty shapes');
  assert.ok(pixels.green > 5000, 'Diagram fill must render');
  await shot('02-pptx');
  result.checks.push('PPTX static canvas preview, Chinese/table text and speaker notes');
  const tab = await page.locator('main .tab').filter({ hasText: '控制系统课件.pptx' }).boundingBox();
  const companion = await page.locator('.companion').boundingBox();
  await page.mouse.move(tab.x + tab.width * 0.4, tab.y + tab.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(companion.x + 60, companion.y + 120, { steps: 15 });
  await page.mouse.up();
  await page.locator('.study-dock .document-sheet').waitFor();
  assert.ok(await page.locator('.companion').evaluate((el) => el.classList.contains('compact-ai')));
  await shot('03-document-dock');
  await page.getByRole('button', { name: '文档移至另一侧', exact: true }).click();
  await page.locator('main .document-sheet').waitFor();
  result.checks.push('Document docking uses compact AI and returns without stuck drag state');
  await open(legacyFile);
  await page.locator('.legacy-slide').waitFor();
  assert.match(await page.locator('.legacy-slide').innerText(), /简化文字阅读/);
  await shot('04-legacy-ppt');
  result.checks.push('Legacy compound PPT text reading clearly labels fidelity limitation');
  // Restore original frozen document page for real tool requests.
  await page.locator('main .tab').filter({ hasText: '课程讲义.pdf' }).click();
  await page.getByRole('spinbutton', { name: '文档页码', exact: true }).fill('2');
  await page.locator('main .document-sheet img[alt="第 2 页"]').waitFor();
  await page.getByTitle('框选图表，供 AI 按需查看', { exact: true }).click();
  const pdfBox = await page.locator('main .document-sheet').boundingBox();
  await page.mouse.move(pdfBox.x + 80, pdfBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(pdfBox.x + 280, pdfBox.y + 230, { steps: 10 });
  await page.mouse.up();
  await page.locator('.document-selection').filter({ hasText: '图表区域' }).waitFor();
  await page.evaluate(async (base) => {
    const s = await window.studyMate.ai({ action: 'state' });
    await window.studyMate.ai({
      action: 'configure',
      config: {
        ...s.config,
        preset: 'custom',
        protocol: 'chat',
        baseUrl: base,
        model: 'fixture-document',
        contextSize: 32768,
        maxOutput: 4096,
      },
      key: 'fixture',
    });
  }, 'http://127.0.0.1:' + server.address().port);
  await page
    .getByRole('textbox', { name: '伴学提问', exact: true })
    .fill('请按需读取当前页和第二页图表，给出来源');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(() => Promise.resolve(!!releaseFirst));
  await page.locator('main .tab').filter({ hasText: '控制系统课件.pptx' }).click();
  releaseFirst();
  await until(() =>
    page.evaluate(() =>
      window.studyMate
        .ai({ action: 'state' })
        .then((s) => !s.busy && s.messages.some((m) => m.role === 'assistant' && m.status === 'complete')),
    ),
  );
  assert.ok(requests.length >= 2);
  assert.doesNotMatch(JSON.stringify(requests[0]), /PAGE_[123]_PRIVATE_EVIDENCE/);
  const all = JSON.stringify(requests.at(-1));
  assert.match(all, /PAGE_2_PRIVATE/);
  assert.match(all, /data:image\/webp;base64/);
  assert.doesNotMatch(all, /PAGE_1_PRIVATE/);
  assert.equal(requests[0].tools.length, 23);
  assert.deepEqual(requests[0].tools, requests[1].tools);
  assert.match(JSON.stringify(requests[0]), /selection/);
  assert.doesNotMatch(all, /SLIDE_1_PRIVATE/);
  await page.locator('.citation-link').click();
  await page.locator('main .document-sheet img[alt="第 2 页"]').waitFor();
  await shot('05-document-ai');
  result.checks.push(
    'Real document tool loop sends metadata first, page text and WebP only on demand, stable schemas, clickable citation',
  );
  const citationNote = '[讲义·第3页](study-cite://' + doc.id + '/3)';
  await page.evaluate(
    (content) =>
      window.studyMate.saveNote({
        path: '文档来源.md',
        content: '# 文档来源\n\n' + content,
        expectedVersion: null,
        operationId: 'doc-citation-test',
      }),
    citationNote,
  );
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('文档来源');
  await page.locator('.search-results button').filter({ hasText: '文档来源' }).first().click();
  await page.locator('.note-preview a').filter({ hasText: '讲义·第3页' }).click();
  await page.locator('main .document-sheet img[alt="第 3 页"]').waitFor();
  result.checks.push('Saved Markdown citation opens the exact registered document page');
  await assert.rejects(
    page.evaluate(() => window.studyMate.document({ action: 'get', id: 'doc-' + '0'.repeat(24) })),
    /未注册/,
  );
  assert.deepEqual(await fs.readFile(pdfFile), original);
  // PDF.js upstream regression sample, downloaded once to D:\study-mate\.cache\fixtures.
  await fs.access(protectedFile);
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, protectedFile);
  await page.getByRole('button', { name: '打开 PDF / PowerPoint', exact: true }).click();
  await page.locator('.document-locked').waitFor();
  await page.getByRole('textbox', { name: 'PDF密码', exact: true }).fill('incorrect');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByText('密码不正确，请重新输入。', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'PDF密码', exact: true }).fill('ELXRTQWS');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.locator('main .document-sheet img').waitFor();
  await app.close();
  app = await _electron.launch({
    executablePath: packed ? executable : electronPath,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await page.getByTitle('password-issue3371.pdf', { exact: true }).click();
  await page.locator('.document-locked').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'PDF密码', exact: true }).inputValue(), '');
  assert.doesNotMatch(await fs.readFile(path.join(data, 'documents/library.json'), 'utf8'), /ELXRTQWS/);
  await shot('06-password-restart');
  result.checks.push(
    'Encrypted PDF rejects wrong password, renders with correct password, requires unlock again after restart; no persisted password',
  );
  assert.deepEqual(result.errors, []);
  result.checks.push('Unknown IDs denied; source PDF bytes unchanged; no renderer errors');
  result.passed = true;
} catch (e) {
  result.error = e.stack || String(e);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise((r) => server.close(r));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
