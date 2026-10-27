import { _electron } from 'playwright-core';
import executablePath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const dataDir = path.join(root, '.cache', 'bilibili-smoke-' + Date.now());
const artifacts = path.join(root, 'artifacts', 'bilibili-smoke');
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, STUDYMATE_DATA_DIR: dataDir, STUDYMATE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const result = {
  passed: false,
  url: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=1',
  at: new Date().toISOString(),
  account: 'isolated profile, not signed in',
};
let app;
try {
  app = await _electron.launch({ executablePath, args: [root], env });
  const page = await app.firstWindow();
  await page.getByText('内置视频解析已就绪', { exact: true }).waitFor();
  await page
    .evaluate((url) => window.studyMate.openWeb(url), result.url)
    .catch((error) => {
      result.pageError = error.message;
    });
  const task = await page.evaluate(() => window.studyMate.analyze({ start: 5, end: 15, count: 3 }));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.studyMate.state());
    const job = state.tasks.find((item) => item.id === task);
    if (['succeeded', 'failed', 'cancelled'].includes(job?.status)) {
      result.task = job;
      if (state.analysis) {
        result.analysis = {
          title: state.analysis.title,
          width: state.analysis.width,
          height: state.analysis.height,
          duration: state.analysis.duration,
          frames: state.analysis.frames.map(({ timestamp, width, height }) => ({ timestamp, width, height })),
        };
        await page.getByRole('button', { name: /查看解析结果/ }).click();
        await page.screenshot({ path: path.join(artifacts, 'analysis.png') });
      }
      result.passed = job.status === 'succeeded';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!result.task) result.error = 'Timed out waiting for actual Bilibili extraction';
} catch (error) {
  result.error = error.message;
} finally {
  await app?.close();
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
