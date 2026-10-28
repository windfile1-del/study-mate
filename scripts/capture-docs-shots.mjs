import { _electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = 'D:\\study-mate';
const exe = path.join(root, 'release', '0.14.0', 'win-unpacked', 'Study Mate.exe');
const docsImgDir = path.join(root, 'docs', 'images');
await fs.mkdir(docsImgDir, { recursive: true });

const testData = path.join(root, '.cache', 'readme-screenshots-' + Date.now());
await fs.mkdir(testData, { recursive: true });

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
  w.setSize(1440, 920);
  w.show();
  w.focus();
});

await page.waitForTimeout(2000);

// 1. Home Workbench Overview
await page.screenshot({ path: path.join(docsImgDir, '01-workbench-home.png'), animations: 'disabled' });
console.log('01-workbench-home.png captured');

// Open the default start note
const noteEntry = page.getByText('开始使用.md').first();
if (await noteEntry.count() > 0) {
  await noteEntry.click();
  await page.waitForTimeout(1500);
}
// 2. Note Editor / Workspace view
await page.screenshot({ path: path.join(docsImgDir, '02-note-editor.png'), animations: 'disabled' });
console.log('02-note-editor.png captured');

// 3. Open Learning Engine Dialog
const learnBtn = page.getByRole('button', { name: /识别与全库检索/ }).first();
if (await learnBtn.count() > 0) {
  await learnBtn.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(docsImgDir, '03-learning-engine.png'), animations: 'disabled' });
  console.log('03-learning-engine.png captured');
  
  // Switch to video cache tab
  const cacheTab = page.getByRole('button', { name: /视频缓存/ }).first();
  if (await cacheTab.count() > 0) {
    await cacheTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(docsImgDir, '04-video-cache.png'), animations: 'disabled' });
    console.log('04-video-cache.png captured');
  }
  
  const closeBtn = page.getByRole('button', { name: /关闭/ }).first();
  if (await closeBtn.count() > 0) await closeBtn.click();
  await page.waitForTimeout(500);
}

// 4. Open AI Settings dialog
const aiSettingsBtn = page.getByRole('button', { name: /AI 接入设置|模型设置/ }).first();
if (await aiSettingsBtn.count() > 0) {
  await aiSettingsBtn.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(docsImgDir, '05-ai-settings.png'), animations: 'disabled' });
  console.log('05-ai-settings.png captured');
  
  const closeAi = page.getByRole('button', { name: /关闭/ }).first();
  if (await closeAi.count() > 0) await closeAi.click();
  await page.waitForTimeout(500);
}

await app.close();
console.log('SCREENSHOTS_DONE');
