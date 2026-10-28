import { _electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = process.cwd(),
  packed = process.argv.includes('--packed');
const executable =
  process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.12.0/win-unpacked/Study Mate.exe');
const data = path.join(root, '.cache', 'workspace-ai-' + Date.now()),
  vault = path.join(data, 'vault-fixture'),
  artifacts = path.join(root, 'artifacts', packed ? 'workspace-ai-packed' : 'workspace-ai');
await fs.mkdir(vault, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const formula = String.raw`# 根轨迹与闭环系统

行内增益 $K^*=K\cdot\frac{\prod_{i=1}^{n-l}|p_i|}{\prod_{i=1}^{m-l}|z_i|}$，其上下标应彼此分开。

$$
\Phi(s)=\frac{G(s)}{1+G(s)H(s)}=\frac{\frac{N_g}{D_g}}{1+\frac{N_gN_h}{D_gD_h}}=\frac{N_g(s)D_h(s)}{D_g(s)D_h(s)+N_g(s)N_h(s)}
$$

幅值条件 $K^*\cdot\frac{\prod_{j=1}^{m}|s-p_j|}{\prod_{i=1}^{n}|s-z_i|}=\frac{所有开环极点到该测试点的几何矢量长度乘积}{所有开环零点到该测试点的几何矢量长度乘积}$。

下一段文字不应与公式重叠。[[B|前往关联笔记]]
%%PRIVATE_NOTE_BODY_MUST_NEVER_BE_SENT_050%%
`;
await fs.writeFile(path.join(vault, 'A.md'), formula);
await fs.writeFile(path.join(vault, 'B.md'), '# 关联笔记\n\n这是 B 笔记。[[A|返回根轨迹]]');
await fs.writeFile(
  path.join(vault, '长文.md'),
  Array.from({ length: 180 }, (_, i) => `## 小节 ${i}\n\n内容 ${i} $G(s)=\\frac{1}{s+1}$\n`).join('\n'),
);
let requests = [],
  slow = false;
let failCompact = false;
const server = http.createServer(async (req, res) => {
  if (req.url === '/models') {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ data: [{ id: 'fixture-learning', context_window: 32768 }] }));
    return;
  }
  let text = '';
  req.setEncoding('utf8');
  for await (const c of req) text += c;
  requests.push({ body: JSON.parse(text), authorization: req.headers.authorization });
  const payload = JSON.parse(text),
    messages = payload.messages || [];
  const lastUser = messages.findLastIndex((m) => m.role === 'user' && typeof m.content === 'string');
  if (messages[lastUser]?.content.startsWith('工具验收：')) {
    const results = messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
    const lastRead = results
      .filter((m) => {
        try {
          return JSON.parse(m.content).version;
        } catch {
          return false;
        }
      })
      .at(-1);
    const version = lastRead ? JSON.parse(lastRead.content).version : '';
    const videoResult = results.find((m) => {
      try {
        return JSON.parse(m.content).sampled_range;
      } catch {
        return false;
      }
    });
    const operations = [
      ['list_notes', { directory: '', offset: 0, limit: 20 }],
      ['search_notes', { query: '根轨迹' }],
      ['read_note', { path: 'A.md', start_line: 1, line_count: 200 }],
      [
        'replace_in_note',
        {
          path: 'A.md',
          old_text: '下一段文字不应与公式重叠。',
          new_text: 'AI 工具已精确更新此段。',
          expected_version: version,
          replace_all: false,
        },
      ],
      ['read_note', { path: 'A.md', start_line: 1, line_count: 200 }],
      ['analyze_video', { start: 0, end: 2, frames: 2 }],
      [
        'insert_image',
        {
          path: 'A.md',
          image: videoResult ? JSON.parse(videoResult.content).frames[0].image : '',
          alt: '课程抽帧',
          after_text: 'AI 工具已精确更新此段。',
          expected_version: version,
        },
      ],
      [
        'save_note',
        {
          path: 'AI工具验收.md',
          content: '# 视频学习记录\n\n已分析0至2秒的两张实际画面，非完整视频或音轨。\n',
          expected_version: null,
        },
      ],
    ];
    const operation = operations[results.length];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const choice = operation
      ? {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'study-call-' + results.length,
                type: 'function',
                function: { name: operation[0], arguments: JSON.stringify(operation[1]) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        }
      : {
          delta: { content: '已读取并精确修改笔记，抽取0至2秒的两张真实画面，插图与学习记录均已保存。' },
          finish_reason: 'stop',
        };
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [choice],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 24,
            total_tokens: 1224,
            prompt_tokens_details: { cached_tokens: 900 },
          },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  const compact = JSON.parse(text).messages?.[0]?.content?.includes('你在压缩学习对话');
  if (compact && failCompact) {
    res.writeHead(503).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: {
              content: compact
                ? '用户目标：学习控制系统；笔记路径 A.md，尚未读取；保留约束：不修改文件。'
                : '## 学习结论\n\n已收到笔记路径。当前没有读取工具，请提供相关片段。',
            },
          },
        ],
      }) +
      '\n\n',
  );
  if (slow) {
    res.on('close', () => res.end());
    return;
  }
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 24,
          total_tokens: 144,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
let application, page;
const findings = { passed: false, checks: [], screenshots: [], errors: [], geometry: {} };
async function shot(name) {
  const file = path.join(artifacts, name + '.png');
  await page.screenshot({ path: file, timeout: 30000 });
  findings.screenshots.push(file);
}
async function nativeShot(name) {
  const images = await application.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const win = BrowserWindow.getAllWindows()[0],
      view = win.contentView.children.find((v) => 'webContents' in v);
    const video = (await view.webContents.capturePage()).toPNG().toString('base64');
    let windowImage = null;
    try {
      const id = win.getMediaSourceId();
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1850, height: 1200 },
      });
      const source = sources.find((s) => s.id === id);
      if (source && !source.thumbnail.isEmpty()) windowImage = source.thumbnail.toPNG().toString('base64');
    } catch {}
    return { video, windowImage };
  });
  for (const [suffix, base64] of Object.entries(images))
    if (base64) {
      const file = path.join(artifacts, name + '-' + suffix + '.png');
      await fs.writeFile(file, Buffer.from(base64, 'base64'));
      findings.screenshots.push(file);
    }
}
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('等待条件超时');
}
async function open(name) {
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(name);
  await page
    .locator('.search-results button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first()
    .click();
  await page
    .locator('.note-pane[data-pane="main"] .note-toolbar')
    .filter({ hasText: name + '.md' })
    .waitFor();
  await page.locator('.note-pane[data-pane="main"] .note-preview[data-loading="false"]').waitFor();
}
async function separator(label, dx, dy = 0) {
  const b = await page.getByRole('separator', { name: label }).boundingBox();
  assert.ok(b);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}
try {
  const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (packed) {
    env.PATH = 'C:\\Windows\\System32;C:\\Windows';
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
  }
  application = await _electron.launch({
    executablePath: packed ? executable : electronPath,
    args: packed ? [] : [root],
    cwd: packed ? path.dirname(executable) : root,
    env,
    timeout: 30000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => findings.errors.push(e.message));
  await page.getByRole('button', { name: 'AI 接入设置', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1480, 960);
    w.showInactive();
  });
  await application.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, vault);
  await page.getByRole('button', { name: '切换知识库', exact: true }).click();
  await until(() => page.evaluate((dir) => window.studyMate.state().then((s) => s.vaultPath === dir), vault));
  await open('A');
  await page.locator('.katex .vlist').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  findings.geometry.math = await page.locator('.note-pane[data-pane="main"]').evaluate((el) => {
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    return {
      rows: [...el.querySelectorAll('.note-rendered-block')].map(rect),
      vlists: [...el.querySelectorAll('.katex .vlist')]
        .slice(0, 8)
        .map((e) => ({ position: getComputedStyle(e).position, ...rect(e) })),
      mathml: [...el.querySelectorAll('.katex-mathml')].map((e) => ({
        position: getComputedStyle(e).position,
        width: e.getBoundingClientRect().width,
      })),
    };
  });
  assert.ok(findings.geometry.math.vlists.every((v) => v.position === 'relative'));
  assert.ok(findings.geometry.math.mathml.every((m) => m.position === 'absolute' && m.width <= 1));
  assert.ok(
    await page.locator('.katex.cjk-fraction .katex-html').evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node,
        min = 100,
        count = 0;
      while ((node = walker.nextNode())) {
        if (/[\u3400-\u9fff]/.test(node.textContent)) {
          const r = document.createRange();
          r.selectNodeContents(node);
          min = Math.min(min, r.getBoundingClientRect().height);
          count++;
        }
      }
      return count > 0 && min >= 13;
    }),
  );
  assert.equal(await page.locator('.note-preview pre').count(), 0);
  const rows = findings.geometry.math.rows;
  assert.ok(rows.every((r, i) => i === 0 || r.top >= rows[i - 1].bottom - 1));
  await shot('01-complex-formulas');
  findings.checks.push(
    'KaTeX engine/style version aligned; inline products and nested fractions have nonoverlapping measured rows',
  );
  await page.getByRole('link', { name: '前往关联笔记', exact: true }).click();
  await page.locator('.note-toolbar').filter({ hasText: 'B.md' }).waitFor();
  assert.equal(await page.locator('main.reader>.tabs button[title$=".md"]').count(), 2);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.note-toolbar').filter({ hasText: 'A.md' }).waitFor();
  await page.keyboard.press('Alt+ArrowRight');
  await page.locator('.note-toolbar').filter({ hasText: 'B.md' }).waitFor();
  await page.getByRole('button', { name: '源码模式', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 笔记内容', exact: true });
  await editor.fill('# B draft\n\n未保存草稿');
  await page.locator('main.reader>.tabs button[title="A.md"]').click();
  await page.locator('main.reader>.tabs button[title="B.md"]').click();
  await until(async () => /未保存草稿/.test(await editor.inputValue()));
  await page.getByRole('button', { name: '关闭笔记 B.md', exact: true }).click();
  await page.getByRole('dialog', { name: '关闭未保存笔记' }).waitFor();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: false }).filter({ hasText: '保存' }).first().click();
  await until(async () => /未保存草稿/.test(await fs.readFile(path.join(vault, 'B.md'), 'utf8')));
  findings.checks.push(
    'Multiple tabs, link back/forward, retained drafts, dirty-close cancellation and explicit save',
  );
  await open('长文');
  const noteScroll = page.locator('.note-pane[data-pane="main"] .note-preview-scroll');
  await noteScroll.evaluate((el) => {
    el.scrollTop = 1600;
  });
  await page.waitForTimeout(250);
  const savedOffset = await noteScroll.evaluate((el) => el.scrollTop);
  await page.locator('main.reader>.tabs button[title="A.md"]').click();
  await page.locator('main.reader>.tabs button[title="长文.md"]').click();
  await until(async () => {
    const current = await noteScroll.evaluate((el) => el.scrollTop);
    findings.geometry.scroll = { saved: savedOffset, current };
    return Math.abs(current - savedOffset) < 120;
  });
  findings.checks.push('Long-note scroll offset restores when returning to its tab');
  await page.locator('main.reader>.tabs button[title="B.md"]').click();
  const sidebar = await page.locator('.sidebar').boundingBox();
  await separator('调整目录宽度', 60);
  findings.geometry.sidebar = {
    before: sidebar,
    after: await page.locator('.sidebar').boundingBox(),
    value: await page.getByRole('separator', { name: '调整目录宽度' }).getAttribute('aria-valuenow'),
  };
  assert.ok(
    findings.geometry.sidebar.after.width > sidebar.width + 45,
    JSON.stringify(findings.geometry.sidebar),
  );
  const right = await page.locator('.companion').boundingBox();
  await separator('调整右侧宽度', -100);
  assert.ok((await page.locator('.companion').boundingBox()).width > right.width + 75);
  await page.locator('main.reader>.tabs button[title="A.md"]').click();
  await page.getByRole('button', { name: '笔记移到右侧', exact: true }).click();
  await page.locator('.note-pane[data-pane="side"]').waitFor();
  const height = await page.locator('.study-dock').boundingBox();
  await separator('调整右侧学习区高度', 0, -110);
  findings.geometry.dock = {
    before: height,
    after: await page.locator('.study-dock').boundingBox(),
    value: await page.getByRole('separator', { name: '调整右侧学习区高度' }).getAttribute('aria-valuenow'),
  };
  assert.ok(findings.geometry.dock.after.height < height.height - 50, JSON.stringify(findings.geometry.dock));
  await shot('02-dual-notes');
  // Actual HTML drag-and-drop routes the tab back into the main workspace.
  const tab = page.locator('.study-dock .tabs button[title="A.md"]');
  await tab.dragTo(page.locator('main.reader>.tabs'));
  await page.locator('main.reader>.tabs button[title="A.md"]').waitFor();
  findings.checks.push(
    'All three separators resize by pointer; notes dock and return by actual drag-and-drop',
  );
  const sourceTab = page.locator('main.reader>.tabs button[title="A.md"]');
  const tabRect = await sourceTab.boundingBox(),
    sideRect = await page.locator('.companion').boundingBox();
  await page.mouse.move(tabRect.x + 30, tabRect.y + 18);
  await page.mouse.down();
  await page.mouse.move(sideRect.x + sideRect.width / 2, sideRect.y + 120, { steps: 15 });
  await page.locator('.dock-drop-hint').waitFor();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await until(async () => (await page.locator('.dock-drop-hint').count()) === 0);
  assert.equal(await page.locator('main.reader>.tabs button[title="A.md"]').count(), 1);
  await sourceTab.dragTo(page.locator('.companion'));
  await page.locator('.note-pane[data-pane="side"]').waitFor();
  assert.equal(await page.locator('.dock-drop-hint').count(), 0);
  await page.getByRole('button', { name: '笔记移回工作区', exact: true }).click();
  findings.checks.push(
    'Pointer drag from note to AI region succeeds; Escape cancellation restores normal UI without closing app',
  );
  const video = path.join(root, '.cache/fixtures/flower.mp4');
  await fs.access(video);
  await page.locator('main.reader>.tabs').getByRole('button', { name: '工作台', exact: true }).click();
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, video);
  await page.getByRole('button', { name: '打开本地视频', exact: false }).first().click();
  await until(() => page.evaluate(() => window.studyMate.state().then((s) => s.playback?.duration > 3)));
  const viewId = await application.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.find((v) => 'webContents' in v)?.webContents.id,
  );
  await page.getByRole('button', { name: '视频移到右侧', exact: true }).click();
  await page.locator('.docked-browser').waitFor();
  const rightSurface = await page.locator('.docked-browser .browser-surface').boundingBox();
  assert.ok(rightSurface.width > 200 && rightSurface.height > 100);
  await page.waitForTimeout(200);
  const viewGeometry = await application.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => 'webContents' in v);
    return { bounds: view.getBounds(), visible: view.getVisible() };
  });
  assert.equal(viewGeometry.visible, true);
  for (const k of ['x', 'y', 'width', 'height'])
    assert.ok(Math.abs(viewGeometry.bounds[k] - rightSurface[k]) < 2);
  await shot('06-video-right-note-left');
  await nativeShot('06-native');
  await page.getByRole('button', { name: '视频移回工作区', exact: true }).click();
  await page.locator('main.reader>.tabs button[title="A.md"]').click();
  await page.getByRole('button', { name: '笔记移到右侧', exact: true }).click();
  await page.locator('.note-pane[data-pane="side"] .katex.cjk-fraction').waitFor();
  await shot('07-video-left-note-right');
  await until(() =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.some((v) => v.getVisible()),
    ),
  );
  await nativeShot('07-native');
  await page.getByRole('button', { name: 'AI 接入设置', exact: true }).click();
  await page.getByRole('dialog', { name: '模型接入与设置' }).waitFor();
  await until(() =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.every((v) => !v.getVisible()),
    ),
  );
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.find((v) => 'webContents' in v)?.webContents.id,
    ),
    viewId,
  );
  await page.getByRole('button', { name: '笔记移回工作区', exact: true }).click();
  findings.checks.push(
    'Local video docks in either direction with note alongside; native video WebContents identity preserved',
  );
  await page.getByRole('button', { name: 'AI 接入设置', exact: true }).click();
  await page.getByRole('dialog', { name: '模型接入与设置' }).waitFor();
  await shot('03-subscription-setup');
  const settings = page.getByRole('dialog', { name: '模型接入与设置' });
  await settings.getByRole('button', { name: '自定义 / 本地兼容接口', exact: false }).click();
  await settings.locator('summary').filter({ hasText: '高级设置' }).click();
  await settings.getByRole('textbox', { name: 'AI API 基础地址', exact: true }).fill(base);
  await settings
    .getByRole('textbox', { name: 'API Key', exact: true })
    .fill('fixture-secret-never-plaintext');
  await settings.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await settings.getByRole('combobox', { name: 'AI 模型 ID', exact: true }).fill('fixture-learning');
  await settings.getByRole('spinbutton', { name: '输入单价', exact: true }).fill('2');
  await settings.getByRole('spinbutton', { name: '缓存读取单价', exact: true }).fill('1');
  await settings.getByRole('spinbutton', { name: '输出单价', exact: true }).fill('8');
  await settings.getByRole('button', { name: '保存接入设置', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate.ai({ action: 'state' }).then((s) => s.config.model === 'fixture-learning'),
    ),
  );
  assert.ok(
    !(await fs.readFile(path.join(data, 'ai/settings.json'), 'utf8')).includes(
      'fixture-secret-never-plaintext',
    ),
  );
  await shot('04-api-setup');
  await settings.getByRole('button', { name: '返回学习', exact: true }).click();
  await page.getByRole('checkbox', { name: '笔记路径', exact: true }).check();
  await page.getByRole('textbox', { name: '伴学提问', exact: true }).fill('请解释当前笔记');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate.ai({ action: 'state' }).then((s) => s.messages.at(-1)?.status === 'complete'),
    ),
  );
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].body), /A\.md/);
  assert.ok(!JSON.stringify(requests[0].body).includes('PRIVATE_NOTE_BODY_MUST_NEVER_BE_SENT_050'));
  assert.ok(!JSON.stringify(requests[0].body).includes('几何矢量长度乘积'));
  assert.equal(requests[0].body.tools.length, 23);
  assert.equal(requests[0].authorization, 'Bearer fixture-secret-never-plaintext');
  const ai = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  assert.equal(ai.messages.at(-1).usage.cached, 80);
  assert.equal(ai.messages.at(-1).usage.total, 144);
  assert.ok(ai.messages.at(-1).usage.cost > 0);
  assert.equal(ai.hasKey, true);
  assert.ok(!JSON.stringify(ai).includes('fixture-secret-never-plaintext'));
  await page.locator('.ai-turn-usage').filter({ hasText: '输入 120' }).waitFor();
  await page.getByRole('button', { name: /上下文 .*%/ }).click();
  assert.ok((await page.locator('.ai-messages').boundingBox()).height >= 60);
  assert.equal(await page.locator('.course-toolbox').getAttribute('open'), null);
  await shot('05-chat-usage');
  findings.checks.push(
    'Guided provider setup, native key encryption, model catalog, streamed answer, explicit note attachment, real returned token/cache metrics and price estimate',
  );
  slow = true;
  await page.getByRole('textbox', { name: '伴学提问', exact: true }).fill('停止测试');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await page.getByRole('button', { name: '停止 AI 生成', exact: true }).click();
  await until(() =>
    page.evaluate(() =>
      window.studyMate.ai({ action: 'state' }).then((s) => s.messages.at(-1)?.status === 'cancelled'),
    ),
  );
  findings.checks.push('Stop interrupts actual HTTP stream and preserves cancelled state');

  slow = false;
  const configure = async (patch) =>
    page.evaluate(async (patch) => {
      const s = await window.studyMate.ai({ action: 'state' });
      return window.studyMate.ai({ action: 'configure', config: { ...s.config, ...patch } });
    }, patch);
  // Four extra video tools increase the fixed prefix; reserve room for the same manual-history scenario.
  await configure({ contextSize: 12288, maxOutput: 1024, autoCompact: false });
  async function ask(question) {
    await page.evaluate((text) => window.studyMate.ai({ action: 'send', text }), question);
    await until(() => page.evaluate(() => window.studyMate.ai({ action: 'state' }).then((s) => !s.busy)));
  }
  for (let i = 0; i < 4; i++) await ask('历史学习目标 ' + i + '：' + '重要约束与推导过程。'.repeat(35));
  const originalCount = await page.evaluate(() =>
    window.studyMate.ai({ action: 'state' }).then((s) => s.messages.length),
  );
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
  await until(() =>
    page.evaluate(() => window.studyMate.ai({ action: 'state' }).then((s) => !!s.memory && !s.busy)),
  );
  const compacted = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  assert.ok(compacted.memory.after < compacted.memory.before);
  assert.equal(compacted.messages.length, originalCount);
  assert.ok(compacted.memory.covered > 0);
  await page.locator('.ai-context-memory summary').click();
  await shot('08-context-compression');
  for (let i = 0; i < 2; i++) await ask('继续复习 ' + i + '：' + '保留数字与已确认结论。'.repeat(35));
  const beforeFailure = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  failCompact = true;
  const failure = await page.evaluate(() =>
    window.studyMate.ai({ action: 'compact' }).then(
      () => '',
      (e) => e.message,
    ),
  );
  assert.ok(failure);
  const afterFailure = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  assert.deepEqual(afterFailure.memory, beforeFailure.memory);
  assert.deepEqual(afterFailure.messages, beforeFailure.messages);
  assert.equal(afterFailure.busy, false);
  failCompact = false;
  slow = true;
  await page.evaluate(() => {
    window.__compactResult = null;
    void window.studyMate.ai({ action: 'compact' }).then(
      () => {
        window.__compactResult = 'completed';
      },
      () => {
        window.__compactResult = 'cancelled';
      },
    );
  });
  await until(() => page.evaluate(() => window.studyMate.ai({ action: 'state' }).then((s) => s.compacting)));
  await page.getByRole('button', { name: '停止 AI 生成', exact: true }).click();
  await until(() => page.evaluate(() => window.__compactResult === 'cancelled'));
  const afterCancel = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  assert.equal(afterCancel.busy, false);
  assert.deepEqual(afterCancel.memory, beforeFailure.memory);
  assert.deepEqual(afterCancel.messages, beforeFailure.messages);
  slow = false;
  // Source-link guidance enlarges the stable prefix; retain space for the same three recent full turns.
  await configure({ contextSize: 10240, maxOutput: 512, autoCompact: true, compactAt: 0.5 });
  const current = '当前问题必须保留：推导闭环函数。'.repeat(10);
  await ask(current);
  assert.ok(requests.at(-1).body.messages.at(-1).content.includes(current));
  assert.ok(
    (await page.evaluate(() => window.studyMate.ai({ action: 'state' }))).memory.covered >
      compacted.memory.covered,
  );
  findings.checks.push(
    'Manual and automatic model-based compaction retain original history/current question; failed and cancelled compression preserve prior memory and recover',
  );
  await page.evaluate(() => window.studyMate.ai({ action: 'clear' }));
  await configure({ contextSize: 32768, maxOutput: 2048, autoCompact: false });
  const chosenImage = path.join(data, 'chosen-local-image.png');
  await fs.writeFile(
    chosenImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, chosenImage);
  await page.getByRole('button', { name: '导入图片到知识库', exact: true }).click();
  await page.getByLabel('待参考资料', { exact: true }).waitFor();
  assert.doesNotMatch(await page.getByRole('textbox', { name: '伴学提问', exact: true }).inputValue(),/attachments\/study-mate\/|view_image|请调用/);
  assert.equal(
    (await fs.readdir(path.join(vault, 'attachments/study-mate'))).filter((p) => p.endsWith('.png')).length,
    1,
  );
  findings.checks.push(
    'Local image picker copies selected image into the vault and keeps paths/tool instructions in a removable source reference outside the question',
  );
  const toolStart = requests.length;
  await page.getByRole('checkbox', { name: '允许保存', exact: true }).check();
  await page
    .getByRole('textbox', { name: '伴学提问', exact: true })
    .fill('工具验收：读取当前笔记并精确修改，分析0到2秒的视频，把画面插入笔记并另存学习记录。');
  await page.getByRole('button', { name: '发送 AI 消息', exact: true }).click();
  await until(
    () =>
      page.evaluate(() =>
        window.studyMate
          .ai({ action: 'state' })
          .then((s) => !s.busy && s.messages.at(-1)?.status === 'complete'),
      ),
    45000,
  );
  const toolState = await page.evaluate(() => window.studyMate.ai({ action: 'state' }));
  const toolAnswer = toolState.messages.at(-1);
  assert.equal(toolAnswer.tools.length, 8);
  assert.ok(
    toolAnswer.tools.every((t) => t.status === 'complete'),
    JSON.stringify(toolAnswer.tools),
  );
  assert.equal(toolAnswer.requests, 9);
  assert.equal(toolAnswer.usage.cached, 8100);
  assert.equal(
    toolAnswer.turns,
    undefined,
    'Opaque signatures and pixels stay in main, not repeated over UI IPC',
  );
  const savedA = await fs.readFile(path.join(vault, 'A.md'), 'utf8');
  assert.match(savedA, /AI 工具已精确更新此段/);
  assert.match(savedA, /!\[课程抽帧\]\(attachments\/study-mate\//);
  assert.match(savedA, /PRIVATE_NOTE_BODY_MUST_NEVER_BE_SENT_050/);
  assert.match(await fs.readFile(path.join(vault, 'AI工具验收.md'), 'utf8'), /两张实际画面/);
  await until(async () =>
    (
      await page
        .locator('.note-pane[data-pane="main"] .note-preview')
        .textContent()
        .catch(() => '')
    )?.includes('AI 工具已精确更新此段'),
  );
  await page.locator('.ai-tool-log summary').last().click();
  const insertedImage = page.locator('.note-pane[data-pane="main"] .note-image img').first();
  await insertedImage.waitFor();
  await insertedImage.scrollIntoViewIfNeeded();
  await until(() => insertedImage.evaluate((image) => image.complete && image.naturalWidth > 0));
  await shot('11-study-tools-and-video');
  for (let i = toolStart + 1; i < requests.length; i++) {
    const previous = requests[i - 1].body,
      next = requests[i].body;
    assert.deepEqual(next.messages.slice(0, previous.messages.length), previous.messages);
    assert.deepEqual(next.tools, previous.tools);
  }
  const beforeFollow = requests.at(-1).body;
  await ask('缓存跟进：总结刚才保存的学习记录。');
  assert.deepEqual(
    requests.at(-1).body.messages.slice(0, beforeFollow.messages.length),
    beforeFollow.messages,
  );
  findings.checks.push(
    'Controlled provider tool loop lists/searches/reads/replaces notes, decodes actual video frames, inserts image and saves new note; clean open note refreshes',
  );
  findings.checks.push(
    'Tool requests and next user turn preserve identical history prefix and tool order; weighted token/cache counts aggregate all nine model requests',
  );
  await page.evaluate(() =>
    window.studyMate.ai({
      action: 'configure',
      config: {
        preset: 'siwc',
        protocol: 'siwc',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        effort: 'auto',
        contextSize: 32768,
        maxOutput: 4096,
        inputPrice: null,
        cachedPrice: null,
        outputPrice: null,
        autoCompact: true,
        compactAt: 0.8,
      },
    }),
  );
  await page.locator('.ai-model-picker').filter({ hasText: 'ChatGPT 订阅' }).waitFor();
  await application.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.__studyOAuthUrl = url;
    };
  });
  await page.getByRole('button', { name: 'AI 接入设置', exact: true }).click();
  const authDialog = page.getByRole('dialog', { name: '模型接入与设置' });
  await authDialog.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await authDialog.getByRole('textbox', { name: '官方授权地址', exact: true }).waitFor();
  const url = await application.evaluate(() => globalThis.__studyOAuthUrl);
  const oauth = new URL(url);
  assert.equal(oauth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(oauth.searchParams.get('agent_name_hint'), 'Study Mate');
  assert.ok(oauth.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  assert.equal(await authDialog.getByRole('button', { name: '使用设备码', exact: true }).count(), 0);
  await shot('09-siwc-authorization');
  await authDialog.getByRole('button', { name: '取消本次登录', exact: true }).click();
  await authDialog.getByRole('button', { name: 'Antigravity · 实验接入', exact: false }).click();
  await authDialog.getByRole('button', { name: '使用 Google 账号登录', exact: true }).click();
  await authDialog.getByRole('textbox', { name: '官方授权地址', exact: true }).waitFor();
  const google = new URL(await application.evaluate(() => globalThis.__studyOAuthUrl));
  assert.equal(google.hostname, 'accounts.google.com');
  assert.equal(new URL(google.searchParams.get('redirect_uri')).port, '51121');
  await shot('10-antigravity-authorization');
  await authDialog.getByRole('button', { name: '取消本次登录', exact: true }).click();
  await authDialog.getByRole('button', { name: '返回学习', exact: true }).click();
  findings.checks.push(
    'SIWC opens independent Study Mate registration with plan scope; Antigravity opens Harness-Mate-compatible Google OAuth, both cancel cleanly without account credentials',
  );
  assert.deepEqual(findings.errors, []);
  findings.passed = true;
} catch (e) {
  findings.failure = e.stack;
  process.exitCode = 1;
  if (page) await shot('failure').catch(() => {});
} finally {
  if (application)
    await application
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
  if (application) await application.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
}
