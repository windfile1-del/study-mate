import { _electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import pptxgen from 'pptxgenjs';

const root = 'D:\\study-mate';
const exe = path.join(root, 'release', '0.14.0', 'win-unpacked', 'Study Mate.exe');
const docsImgDir = path.join(root, 'docs', 'images');

const testData = path.join(root, '.cache', 'readme-shots-doc-' + Date.now());
const vault = path.join(testData, 'vault');
await fs.mkdir(vault, { recursive: true });

const ppt = new pptxgen();
const s1 = ppt.addSlide();
s1.addText('自动控制原理 · 课程核心讲义', { x: 1, y: 1.5, w: 8, h: 1, fontSize: 32, bold: true, color: '1b4d3e' });
s1.addText('动态系统控制与数学建模 · 课件导读', { x: 1, y: 2.8, w: 8, h: 0.6, fontSize: 18, color: '4f6f52' });

const s2 = ppt.addSlide();
s2.addText('二阶系统阶跃响应分析', { x: 0.8, y: 0.8, w: 8, h: 0.8, fontSize: 24, bold: true, color: '1b4d3e' });
s2.addText('阻尼比 \u03b6 对系统超调量与调节时间起决定性作用：\n1. 欠阻尼 (0 < \u03b6 < 1)：振荡衰减过程；\n2. 临界阻尼 (\u03b6 = 1)：无超调的最快响应；\n3. 过阻尼 (\u03b6 > 1)：无超调但响应缓慢。', {
  x: 0.8, y: 1.8, w: 8.5, h: 3, fontSize: 16, color: '2d3748', lineSpacing: 26
});

const pptFile = path.join(testData, '自控原理核心讲义.pptx');
await ppt.writeFile({ fileName: pptFile });

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

// Choose and register document
await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
}, pptFile);

await page.evaluate(() => window.studyMate.chooseDocument());
await page.waitForTimeout(1000);

const s = await page.evaluate(() => window.studyMate.state());
const docId = s.documents.find(d => d.title.includes('自控原理')).id;

// Navigate to document view
await page.evaluate((id) => {
  window.studyMate.panel({ action: 'navigate', target: 'document', id });
}, docId);

// Wait for document pane to render
await page.locator('main .document-pane').waitFor({ timeout: 20000 });
await page.waitForTimeout(3000);

await page.screenshot({ path: path.join(docsImgDir, '04-document-reader.png'), animations: 'disabled' });
console.log('04-document-reader.png captured successfully');

await app.close();
