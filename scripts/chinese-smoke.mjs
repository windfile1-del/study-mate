import { _electron } from 'playwright-core';
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = process.cwd(),
  packed = process.argv.includes('--packed'),
  data = path.join(root, '.cache', 'chinese-' + Date.now()),
  artifacts = path.join(root, 'artifacts', packed ? 'chinese-packed' : 'chinese');
await fs.mkdir(data, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const human = await fs.readFile(path.join(root, '.cache/fixtures/sensevoice-zh.wav')),
  terms = await fs.readFile(path.join(root, '.cache/fixtures/speech-zh-control.wav'));
const boardSource =
    process.env.STUDYMATE_CHINESE_BOARD ||
    'D:\\学习网课\\数学与自动控制知识库\\90 附件\\P32_例1_阻尼比0.5系数对比与主导极点.jpg',
  board = path.join(data, '真实中文课件.jpg');
await fs.copyFile(boardSource, board);
const original = await fs.readFile(boardSource);
const requests = [];
let expectedImage = '';
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    req.setEncoding('utf8');
    let text = '';
    for await (const part of req) text += part;
    const payload = JSON.parse(text);
    requests.push(payload);
    const second = payload.messages.some((m) => m.role === 'tool');
    const delta = second
      ? { content: '已读取真实原图。复杂公式与模糊小字需要结合原图核对，OCR仅作参考。' }
      : {
          tool_calls: [
            {
              index: 0,
              id: 'real-image',
              type: 'function',
              function: { name: 'view_image', arguments: JSON.stringify({ path: expectedImage }) },
            },
          ],
        };
    res
      .writeHead(200, { 'Content-Type': 'text/event-stream' })
      .end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta, finish_reason: second ? 'stop' : 'tool_calls' }],
            usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    return;
  }
  if (req.url === '/human.wav' || req.url === '/terms.wav') {
    const b = req.url === '/human.wav' ? human : terms,
      m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''),
      start = m ? +m[1] : 0,
      end = m && m[2] ? Math.min(+m[2], b.length - 1) : b.length - 1;
    res.writeHead(m ? 206 : 200, {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${b.length}` } : {}),
    });
    res.end(b.subarray(start, end + 1));
    return;
  }
  const kind = req.url.includes('terms') ? 'terms' : 'human';
  res
    .writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
    .end(
      '<title>中文' +
        (kind === 'terms' ? '自控术语' : '普通话') +
        '识别验收</title><video controls style="width:800px;height:440px" src="/' +
        kind +
        '.wav"></video>',
    );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const result = { passed: false, checks: [], samples: {}, screenshots: [], errors: [] },
  env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
if (packed) {
  env.PATH = 'C:\\Windows\\System32;C:\\Windows';
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
}
let app, page;
const executable =
  process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.10.0/win-unpacked/Study Mate.exe');
async function until(fn, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('中文识别等待超时');
}
async function shot(name) {
  const file = path.join(artifacts, name + '.png');
  await page.screenshot({ path: file, timeout: 30000 });
  result.screenshots.push(file);
}
const course = async (kind) => {
  await page.evaluate(
    (url) => window.studyMate.openWeb(url),
    'http://127.0.0.1:' + server.address().port + '/' + kind,
  );
  await page.waitForTimeout(800);
};
try {
  app = await _electron.launch({
    executablePath: packed ? executable : electron,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => result.errors.push(e.message));
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await course('human');
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '转写语言' }).inputValue(), 'chinese');
  await page.getByRole('button', { name: '开始课程采音', exact: true }).click();
  await until(() =>
    page.evaluate(() => window.studyMate.recognition({ action: 'state' }).then((s) => s.capturing)),
  );
  await page.evaluate(() => window.studyMate.player({ action: 'play' }));
  await page.waitForTimeout(6800);
  await page.getByRole('button', { name: '停止采音', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate.recognition({ action: 'state' }).then((s) => !s.capturing && !s.queued && !s.processing),
    ),
  );
  let state = await page.evaluate(() => window.studyMate.recognition({ action: 'state' }));
  const zh = state.segments.map((s) => s.text).join('');
  assert.match(zh, /早上/);
  assert.match(zh, /下午/);
  assert.match(zh, /9|九/);
  assert.match(zh, /5|五/);
  result.samples.humanMandarin = {
    source: 'sherpa-onnx public zh.wav human speech',
    reference: '开饭时间早上9点至下午5点',
    recognized: zh,
  };
  await page.waitForTimeout(1100);
  await shot('01-real-mandarin');
  result.checks.push(
    'Real Mandarin course-tab capture uses Chinese by default and recognizes the morning/afternoon numbers with original source times',
  );
  await page.getByRole('button', { name: '返回学习', exact: true }).click();
  await course('terms');
  await page.evaluate(() => window.studyMate.player({ action: 'rate', rate: 2 }));
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  await page.getByRole('button', { name: '开始课程采音', exact: true }).click();
  await until(() =>
    page.evaluate(() => window.studyMate.recognition({ action: 'state' }).then((s) => s.capturing)),
  );
  await page.evaluate(() => window.studyMate.player({ action: 'play' }));
  await page.waitForTimeout(6400);
  await page.evaluate(() => window.studyMate.player({ action: 'pause' }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.studyMate.player({ action: 'seek', time: 14 }));
  await page.evaluate(() => window.studyMate.player({ action: 'rate', rate: 1.5 }));
  await page.evaluate(() => window.studyMate.player({ action: 'play' }));
  await page.waitForTimeout(5200);
  await page.getByRole('button', { name: '停止采音', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate.recognition({ action: 'state' }).then((s) => !s.queued && !s.processing),
    ),
  );
  state = await page.evaluate(() => window.studyMate.recognition({ action: 'state' }));
  const text = state.segments.map((s) => s.text).join(''),
    keywords = ['二阶', '阻尼', '拉普拉斯', '微分方程', '闭环', '主导极点', '稳定性', '调节时间'],
    matched = keywords.filter((k) => text.includes(k));
  result.samples.controlTerminology = {
    kind: 'Windows Chinese synthetic technical speech; not a human lecture',
    recognized: text,
    keywords,
    matched,
    termRecall: matched.length / keywords.length,
  };
  assert.ok(matched.length >= 6, text);
  assert.ok(new Set(state.segments.map((s) => s.epoch)).size >= 2);
  assert.ok(state.segments.some((s) => s.start < 3 && s.end < 14));
  assert.ok(state.segments.some((s) => s.start >= 13.5 && s.end <= 22.5));
  assert.ok(state.segments.every((s) => s.warning && s.confidence === null));
  await page.waitForTimeout(1100);
  await shot('02-chinese-2x-seek');
  result.checks.push(
    'Chinese control terminology tested at 2x and 1.5x with pause/seek; distinct epochs keep original-source ranges, raw recognition and uncertainty',
  );
  await page.getByRole('button', { name: '返回学习', exact: true }).click();
  await page.getByRole('button', { name: '识别与全库检索', exact: true }).click();
  await page.getByRole('button', { name: '课件与板书', exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, board);
  await page.getByText('可选：提取本地 OCR 参考文字', { exact: true }).click();
  await page.getByRole('button', { name: /^导入图片并识别/ }).click();
  await page.locator('.learning-modal .ocr-result').waitFor({ timeout: 120000 });
  const ocr = (await page.evaluate(() => window.studyMate.recognition({ action: 'state' }))).ocr;
  const normalized = ocr.text.replace(/\s/g, '');
  result.samples.realControlBoard = {
    source: boardSource,
    recognized: ocr.text,
    confidence: ocr.confidence,
    lowConfidence: ocr.lowConfidence,
    warnings: ocr.warnings,
  };
  assert.ok(Number.isFinite(ocr.confidence) && ocr.confidence >= 0 && ocr.confidence <= 100);
  assert.equal(ocr.lowConfidence, ocr.confidence < 70);
  assert.equal(ocr.source.kind, 'image');
  assert.ok(ocr.warnings.some((w) => /公式|手写/.test(w)));
  assert.deepEqual(await fs.readFile(boardSource), original);
  await shot('03-real-chinese-board');
  result.checks.push(
    'Actual blurry Chinese control-course image preserves original bytes and source; OCR is optional and poor results remain explicitly low-confidence',
  );
  expectedImage = ocr.source.id;
  await page.evaluate(async (url) => {
    const s = await window.studyMate.ai({ action: 'state' });
    await window.studyMate.ai({
      action: 'configure',
      config: {
        ...s.config,
        preset: 'custom',
        protocol: 'chat',
        model: 'controlled-vision',
        baseUrl: url,
        contextSize: 32768,
        maxOutput: 4096,
      },
      key: 'fixture',
    });
  }, 'http://127.0.0.1:' + server.address().port);
  await page.locator('.ocr-result').getByRole('button', { name: '让 AI 看原图', exact: true }).click();
  await page.getByRole('dialog', { name: '识别与全库检索' }).waitFor({ state: 'hidden' });
  await until(async()=> (await page.getByRole('textbox',{name:'伴学提问',exact:true}).inputValue()).includes(expectedImage));
  const draft = await page.getByRole('textbox', { name: '伴学提问', exact: true }).inputValue();
  assert.ok(draft.includes(expectedImage));
  assert.ok(!draft.includes(ocr.text.trim()) || !ocr.text.trim());
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate
        .ai({ action: 'state' })
        .then((s) => !s.busy && s.messages.at(-1)?.status === 'complete'),
    ),
  );
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /data:image\/.*;base64,/);
  assert.match(JSON.stringify(requests[1].messages), /data:image\/.*;base64,/);
  assert.equal(requests[0].tools.length, 23);
  await page
    .locator('.ai-messages')
    .getByText('已读取真实原图。复杂公式与模糊小字需要结合原图核对，OCR仅作参考。', { exact: true })
    .waitFor();
  await shot('04-primary-multimodal-image');
  result.checks.push(
    'Primary multimodal handoff prepares image path without OCR text, then a real view_image tool sends original pixels to the controlled provider on demand',
  );
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
