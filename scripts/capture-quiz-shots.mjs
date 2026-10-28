import { _electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = 'D:\\study-mate';
const exe = path.join(root, 'release', '0.14.0', 'win-unpacked', 'Study Mate.exe');
const docsImgDir = path.join(root, 'docs', 'images');

const testData = path.join(root, '.cache', 'readme-core-shots-' + Date.now());
const vault = path.join(testData, 'vault');
await fs.mkdir(vault, { recursive: true });

// Note with quiz and exercise
const noteContent = [
  '# 现代控制工程 · 自测练习与错题批改',
  '',
  '## 课堂巩固题（AI 自动生成）',
  '1. **判断题**：二阶欠阻尼系统的阻尼比 \u03b6 越小，系统的超调量越大，振荡越剧烈。（ ）',
  '   - **学生作答**：正确。',
  '   - **AI 批改**：\u2705 **正确**。依据特征根分布，\u03b6 减小时共轭复数极点靠近虚轴，阻尼角增大，最大超调量 \u03c3% = e^(-\u03c0\u03b6/\u221a(1-\u03b6\u00b2)) \u00d7 100% 单调递增。',
  '',
  '2. **计算题**：已知某系统开环传递函数为 $G(s) = \\frac{10}{s(s+2)}$，求负反馈闭环系统的阻尼比 \u03b6 与自然振荡角频率 \u03c9_n。',
  '   - **学生解题草稿**：',
  '     闭环特征方程为 $s^2 + 2s + 10 = 0$。对比标准型 $s^2 + 2\\zeta\\omega_n s + \\omega_n^2 = 0$：',
  '     可得 $\\omega_n = \\sqrt{10} \\approx 3.16$，$\\zeta = 2 / (2\\times\\sqrt{10}) = \\frac{1}{\\sqrt{10}} \\approx 0.316$。',
  '   - **AI 智能评阅**：',
  '     \u2b50 **得分：满分**。推导严谨，特征多项式化简无误，参数匹配准确。建议下一步计算该参数下的调节时间 $t_s \\approx \\frac{3.5}{\\zeta\\omega_n}$。',
  '',
  '---',
  '> 本笔记由 AI 伴学助手根据《自动控制原理视频 14:20》讲解自动总结并生成巩固习题。',
  ''
].join('\n');

await fs.writeFile(path.join(vault, '自测练习与作业批改.md'), noteContent);

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

// Open the quiz & grading note
await page.evaluate(() => {
  window.studyMate.panel({ action: 'navigate', target: 'note', id: '自测练习与作业批改.md' });
});

await page.waitForTimeout(2500);

// Capture note + exercise & grading
await page.screenshot({ path: path.join(docsImgDir, '08-quiz-and-grading.png'), animations: 'disabled' });
console.log('08-quiz-and-grading.png captured');

await app.close();
