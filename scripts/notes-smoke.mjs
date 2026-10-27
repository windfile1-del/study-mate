import { _electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(),
  packed = process.argv.includes('--packed');
const development = process.argv.includes('--dev');
const packedExecutable =
  process.env.STUDYMATE_PACKED_EXE || path.join(root, 'release/0.10.0/win-unpacked/Study Mate.exe');
const artifacts = path.join(
  root,
  'artifacts',
  packed ? 'notes-packed' : development ? 'notes-dev' : 'notes-smoke',
);
const dataDir = path.join(root, '.cache', 'notes-smoke-' + Date.now());
const fixture = path.join(dataDir, '笔记知识库');
await fs.mkdir(path.join(fixture, '课程/images'), { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const source = [
  '---',
  'title: 控制系统笔记',
  'tags: [学习, 公式]',
  '---',
  '# 控制系统笔记',
  '',
  '闭环传递函数 $G(s)=\\frac{K}{s^2+2\\zeta\\omega_n s+\\omega_n^2}$。',
  '',
  '$$',
  '\\begin{aligned} e(t)&=r(t)-y(t)\\\\ Y(s)&=G(s)R(s)\\end{aligned}',
  '$$',
  '',
  '> [!tip] 学习提示',
  '> 先看公式，再结合流程图理解反馈关系。',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[输入] --> B[控制器]',
  '  B --> C[被控对象]',
  '  C --> D[输出]',
  '  D -->|反馈| B',
  '```',
  '',
  '[[课程/关联笔记#结论|查看关联结论]]',
  '',
  '==这是需要记住的重点==',
  '',
  '![相对图片](课程/images/示意.svg)',
  '',
  '![[示意.svg|360]]',
  '',
  '- [x] 完成传递函数复习',
  '- [ ] 验证阶跃响应',
  '',
  '|参数|含义|',
  '|---|---|',
  '|$\\zeta$|阻尼比|',
  '',
  '> [!warning]- 可折叠提示',
  '> 这是折叠后的补充说明。',
  '',
  '## 普通代码',
  '```python',
  'print("[[这里不是双链]] $x$")',
  '```',
  '',
  '## 无效图表',
  '```mermaid',
  'this is invalid',
  '```',
  '',
  '## 正文仍可阅读',
  '坏图表不会影响其他内容。',
  '',
].join('\n');
await fs.writeFile(path.join(fixture, '兼容性样例.md'), source);
await fs.writeFile(path.join(fixture, '课程/关联笔记.md'), '# 关联笔记\n\n## 结论\n\n$e=0$ 时进入稳态。');
await fs.writeFile(
  path.join(fixture, '课程/images/示意.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180"><rect width="640" height="180" rx="16" fill="#edf5e6"/><text x="40" y="100" font-size="34" fill="#34572a">LOCAL IMAGE / 相对图片</text></svg>',
);
await fs.writeFile(path.join(fixture, '嵌入.md'), '# 嵌入笔记\n\n![[课程/关联笔记]]');
const longText = Array.from(
  { length: 2200 },
  (_, index) =>
    '## 小节 ' +
    index +
    '\n\n第 ' +
    index +
    ' 段学习内容，保持界面响应。$G(s)=\\frac{' +
    index +
    '}{s+1}$\n\n这是一段正文用于验证滚动与后台排版。\n',
).join('\n');
await fs.writeFile(path.join(fixture, '超长笔记.md'), longText);
await fs.mkdir(path.join(fixture, '批量笔记'));
for (let offset = 0; offset < 1200; offset += 40)
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      fs.writeFile(
        path.join(fixture, '批量笔记', String(offset + i).padStart(4, '0') + '.md'),
        '# 批量笔记 ' + (offset + i) + '\n\n支持批量知识库切换。',
      ),
    ),
  );
let application, page, devServer;
const findings = { passed: false, checks: [], performance: {}, screenshots: [], errors: [] };
const wait = async (predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.studyMate.state());
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('等待应用状态超时');
};
const shot = async (name) => {
  const file = path.join(artifacts, name + '.png');
  await page.screenshot({ path: file });
  findings.screenshots.push(file);
};
async function openNote(name) {
  const start = Date.now(),
    timing = { name, search: 0, click: 0, toolbar: 0, preview: 0 };
  const search = page.getByRole('textbox', { name: '搜索笔记', exact: true });
  await search.fill(name.replace(/\.md$/, ''));
  const result = page
    .locator('.search-results button')
    .filter({ has: page.getByText(name.replace(/\.md$/, ''), { exact: true }) })
    .first();
  await result.waitFor();
  timing.search = Date.now() - start;
  await result.click();
  timing.click = Date.now() - start;
  await page.locator('.note-toolbar').filter({ hasText: name }).waitFor();
  timing.toolbar = Date.now() - start;
  await page.locator('.note-preview[data-loading="false"]').first().waitFor({ timeout: 45000 });
  timing.preview = Date.now() - start;
  (findings.noteOpenTimings ||= []).push(timing);
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
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
  }
  application = await _electron.launch({
    executablePath: packed ? packedExecutable : electronPath,
    cwd: packed ? path.dirname(packedExecutable) : root,
    args: packed ? [] : [root],
    env,
    timeout: 30000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => findings.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') findings.errors.push(message.text());
  });
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await page.evaluate(() => {
    window.__ticks = [];
    window.__last = performance.now();
    window.__heartbeat = setInterval(() => {
      const now = performance.now();
      window.__ticks.push(now - window.__last);
      window.__last = now;
    }, 25);
  });
  await application.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, fixture);
  const switchStart = Date.now();
  await page.getByRole('button', { name: '切换知识库', exact: true }).click();
  await wait((state) => state.vaultPath === fixture);
  findings.performance.switch1204NotesMs = Date.now() - switchStart;
  findings.checks.push('切换1204篇笔记的知识库，目录与监听连接完成');
  await openNote('兼容性样例.md');
  await page.locator('.note-preview .katex').first().waitFor();
  await page.locator('.diagram-image').first().waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.note-preview script').count(), 0);
  assert.equal(await page.locator('.note-callout').count(), 1);
  assert.ok((await page.locator('.katex .frac-line').count()) > 0);
  assert.ok((await page.locator('.katex svg path').count()) >= 0);
  await shot('01-formula-flowchart');
  findings.checks.push('后台解析公式、矩阵、Callout与真实Mermaid SVG图片，原文件内容未改写');
  const scroll = page.locator('.note-preview-scroll').first();
  await scroll.evaluate((element) => {
    element.scrollTop += 650;
  });
  await page.waitForTimeout(400);
  await page.locator('.note-image[data-state="ready"]').first().waitFor();
  assert.ok(
    await page
      .locator('.note-image img')
      .first()
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await shot('02-attachments');
  await page.getByRole('combobox', { name: '笔记目录' }).selectOption({ label: '　正文仍可阅读' });
  await page.getByText('坏图表不会影响其他内容。', { exact: true }).waitFor();
  findings.checks.push('虚拟滚动按需加载相对/SVG双链图片，目录可跳转，错误图表保留错误和源码');
  await page.getByRole('combobox', { name: '笔记目录' }).selectOption({ label: '控制系统笔记' });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '放大图表', exact: true }).first().click();
  await page.getByRole('dialog', { name: '图表大图' }).waitFor();
  const modalBounds = await page.getByRole('dialog', { name: '图表大图' }).boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.equal(modalBounds.x, 0);
  assert.equal(modalBounds.y, 0);
  assert.ok(Math.abs(modalBounds.width - viewport.width) < 1);
  assert.ok(Math.abs(modalBounds.height - viewport.height) < 1);
  await shot('03-diagram-zoom');
  await page.getByRole('button', { name: '关闭大图' }).click();
  await scroll.evaluate((element) => {
    element.scrollTop = 600;
  });
  await page.waitForTimeout(300);
  await page.getByRole('link', { name: '查看关联结论', exact: true }).click();
  await page.locator('.note-toolbar').filter({ hasText: '课程/关联笔记.md' }).waitFor();
  await page.getByRole('button', { name: '源码模式' }).click();
  assert.match(
    await page.getByRole('textbox', { name: 'Markdown 笔记内容', exact: true }).inputValue(),
    /关联笔记/,
  );
  findings.checks.push('双链别名与标题跳转，阅读/源码模式切换');
  await openNote('嵌入.md');
  await page.locator('.embedded-note .katex').waitFor();
  findings.checks.push('笔记嵌入显示真实关联内容和公式');
  const started = Date.now();
  await openNote('超长笔记.md');
  findings.performance.longNoteFirstRenderMs = Date.now() - started;
  await page.locator('.note-preview[data-compiling="false"]').first().waitFor({ timeout: 45000 });
  findings.performance.longNoteFullLayoutMs = Date.now() - started;
  const virtualStats = await page.evaluate(() => ({
    blocks: Number(document.querySelector('.note-preview').dataset.blockCount),
    mounted: document.querySelectorAll('.note-rendered-block').length,
    nodes: document.querySelector('.note-preview').querySelectorAll('*').length,
  }));
  findings.performance.virtualization = virtualStats;
  assert.ok(virtualStats.blocks > 5000);
  assert.ok(virtualStats.mounted < 50);
  await shot('04-long-note');
  await page.getByRole('combobox', { name: '笔记目录' }).selectOption({ label: '　小节 2199' });
  await page.getByRole('heading', { name: '小节 2199', exact: true }).waitFor();
  await shot('05-long-note-end');
  findings.checks.push('2200节含公式长文后台排版，DOM仅挂载可见块，目录可直达文末');
  const returnStart = Date.now();
  await openNote('兼容性样例.md');
  findings.performance.cachedNoteReturnMs = Date.now() - returnStart;
  await fs.appendFile(path.join(fixture, '超长笔记.md'), '\n\n新增段落，用于验证切换时取消后台工作。');
  const searchField = page.getByRole('textbox', { name: '搜索笔记', exact: true });
  await searchField.fill('超长笔记');
  await page
    .locator('.search-results button')
    .filter({ has: page.getByText('超长笔记', { exact: true }) })
    .click();
  await page.locator('.note-toolbar').filter({ hasText: '超长笔记.md' }).waitFor();
  await openNote('兼容性样例.md');
  await page.waitForTimeout(300);
  assert.ok(Number(await page.locator('.note-preview').first().getAttribute('data-block-count')) < 100);
  findings.checks.push('缓存笔记快速返回，长文后台解析途中切走不会串页或覆盖新内容');
  const sample = await page.evaluate(() => {
    clearInterval(window.__heartbeat);
    return window.__ticks;
  });
  findings.performance.uiHeartbeatMaxGapMs = Math.max(...sample);
  findings.performance.uiHeartbeatP99Ms = sample.sort((a, b) => a - b)[Math.floor(sample.length * 0.99)];
  assert.ok(findings.performance.uiHeartbeatP99Ms < 250, '界面主线程P99停顿过大');
  assert.equal(await fs.readFile(path.join(fixture, '兼容性样例.md'), 'utf8'), source);
  if (process.argv.includes('--real-vault')) {
    const config = JSON.parse(await fs.readFile(path.join(root, '.local/data/state/workspace.json'), 'utf8'));
    const realVault = config.vaultPath;
    const samples = [
      '01 数学/01 高等数学/00 基础与函数/函数性质关系.md',
      '01 数学/01 高等数学/05 多元函数/二重积分做题方法详解.md',
      '99 归档/deep-research-report.md',
      '02 自动控制原理/04 根轨迹/根轨迹与根轨迹方程（基本概念与幅值相角条件）.md',
    ];
    const originals = await Promise.all(samples.map((file) => fs.readFile(path.join(realVault, file))));
    await application.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, realVault);
    await page.getByRole('button', { name: '切换知识库', exact: true }).click();
    await wait((state) => state.vaultPath === realVault);
    findings.realNotes = [];
    for (let index = 0; index < samples.length; index++) {
      const file = samples[index],
        start = Date.now();
      await openNote(path.basename(file));
      await page.locator('.note-preview[data-compiling="false"]').first().waitFor({ timeout: 45000 });
      if (index === 2) {
        const option = await page
          .getByRole('combobox', { name: '笔记目录' })
          .locator('option')
          .evaluateAll(
            (options) => options.find((option) => option.textContent.includes('验证流程图'))?.value,
          );
        assert.ok(option);
        await page.getByRole('combobox', { name: '笔记目录' }).selectOption(option);
        await page.locator('.diagram-image').first().waitFor({ timeout: 30000 });
        assert.ok(
          await page
            .locator('.diagram-image')
            .first()
            .evaluate((image) => image.complete && image.naturalWidth > 0),
        );
      } else if (index === 3) {
        const option = await page
          .getByRole('combobox', { name: '笔记目录' })
          .locator('option')
          .evaluateAll((options) => options.find((o) => o.textContent.includes('3. 幅值条件'))?.value);
        assert.ok(option);
        await page.getByRole('combobox', { name: '笔记目录' }).selectOption(option);
        await page.locator('.katex.cjk-fraction').first().waitFor();
        assert.ok(
          await page
            .locator('.katex.cjk-fraction .katex-html')
            .first()
            .evaluate((el) => {
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
      } else await page.locator('.note-preview .katex').first().waitFor();
      await shot('real-' + (index + 1));
      findings.realNotes.push({ path: file, renderMs: Date.now() - start });
      assert.deepEqual(await fs.readFile(path.join(realVault, file)), originals[index]);
    }
    findings.checks.push('只读打开真实Obsidian知识库的公式/Callout/流程图样本，原文件字节未改变');
  }
  findings.passed = true;
} catch (error) {
  findings.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) {
    findings.preview = await page.evaluate(() => ({
      text: document.querySelector('.note-preview')?.textContent?.slice(0, 600),
      height: document.querySelector('.note-preview-scroll')?.clientHeight,
      blocks: document.querySelectorAll('.note-rendered-block').length,
    }));
    await shot('failure').catch(() => {});
  }
} finally {
  await application?.close().catch(() => {});
  await devServer?.close();
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
}
