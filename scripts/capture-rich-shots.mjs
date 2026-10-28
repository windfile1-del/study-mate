import { _electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = 'D:\\study-mate';
const exe = path.join(root, 'release', '0.14.0', 'win-unpacked', 'Study Mate.exe');
const docsImgDir = path.join(root, 'docs', 'images');

const testData = path.join(root, '.cache', 'readme-screenshots-detailed-' + Date.now());
const vault = path.join(testData, 'vault');
await fs.mkdir(vault, { recursive: true });

const noteContent = [
  '# 第二章 控制系统的数学模型',
  '',
  '## 2.1 传递函数的定义与性质',
  '传递函数是**线性定常系统**在零初始条件下，输出量的拉普拉斯变换与输入量的拉普拉斯变换之比。',
  '',
  '$$',
  'G(s) = \\frac{Y(s)}{U(s)} = \\frac{b_m s^m + b_{m-1} s^{m-1} + \\dots + b_0}{a_n s^n + a_{n-1} s^{n-1} + \\dots + a_0}',
  '$$',
  '',
  '### 核心特点',
  '- 只取决于系统本身的结构和参数，与输入形式无关；',
  '- 零初始条件意味着在 $t \\le 0$ 时，输入及其各阶导数均为零；',
  '- 闭环特征方程根的分布直接决定了系统的稳定性与响应速度。',
  '',
  '```mermaid',
  'graph LR',
  '    R[输入信号 R] --> Sum((+))',
  '    Sum --> G[前向通道 G]',
  '    G --> Y[输出信号 Y]',
  '    Y --> H[反馈回路 H]',
  '    H -->|反相-| Sum',
  '```',
  ''
].join('\n');

await fs.writeFile(path.join(vault, '自动控制原理学习笔记.md'), noteContent);

const env = {
  ...process.env,
  STUDYMATE_DATA_DIR: testData,
  STUDYMATE_SMOKE: '1',
  TEMP: path.join(root, '.cache', 'temp'),
  TMP: path.join(root, '.cache', 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const app = await _electron.launch({
  executablePath: exe,
  args: [],
  cwd: testData,
  env,
  timeout: 60000,
});

const page = await app.firstWindow();
page.setDefaultTimeout(20000);

await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setSize(1480, 940);
  w.show();
  w.focus();
});

await page.waitForTimeout(2000);

// Open the sample note
const noteItem = page.getByText('自动控制原理学习笔记.md').first();
if (await noteItem.count() > 0) {
  await noteItem.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(docsImgDir, '02-note-editor.png'), animations: 'disabled' });
  console.log('02-note-editor.png saved with rich note content');
}

// Open Search tab inside Learning Engine
const learnBtn = page.getByRole('button', { name: /识别与全库检索/ }).first();
if (await learnBtn.count() > 0) {
  await learnBtn.click();
  await page.waitForTimeout(1500);
  const searchTab = page.getByRole('button', { name: /全库检索/ }).first();
  if (await searchTab.count() > 0) {
    await searchTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(docsImgDir, '06-knowledge-search.png'), animations: 'disabled' });
    console.log('06-knowledge-search.png saved');
  }
}

await app.close();
console.log('DETAILED_SHOTS_DONE');
