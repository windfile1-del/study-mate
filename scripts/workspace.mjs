import { mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, '.cache');
if (process.platform === 'win32' && !/^d:/i.test(root)) {
  throw new Error('请将项目放在 D 盘，临时文件只允许存放到 D 盘。');
}
for (const folder of ['temp', 'npm', 'electron', 'builder'])
  mkdirSync(resolve(cache, folder), { recursive: true });
const env = {
  ...process.env,
  TEMP: resolve(cache, 'temp'),
  TMP: resolve(cache, 'temp'),
  TMPDIR: resolve(cache, 'temp'),
  npm_config_cache: resolve(cache, 'npm'),
  ELECTRON_CACHE: resolve(cache, 'electron'),
  ELECTRON_BUILDER_CACHE: resolve(cache, 'builder'),
  STUDYMATE_DATA_DIR: process.env.STUDYMATE_DATA_DIR || resolve(root, '.local/data'),
};
delete env.ELECTRON_RUN_AS_NODE;
const command = process.argv[2];
const testDir = resolve(root, 'tests');
const files =
  command === 'test'
    ? readdirSync(testDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.test.ts'))
        .map((f) => resolve(testDir, f.name))
    : [];
const commands = {
  dev: ['node_modules/electron-vite/bin/electron-vite.js', 'dev'],
  build: ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
  check: ['node_modules/typescript/bin/tsc', '--noEmit'],
  test: ['node_modules/tsx/dist/cli.mjs', '--test', ...files],
  start: ['node_modules/electron/cli.js', '.'],
  smoke: ['scripts/smoke.mjs'],
  'smoke-dev': ['scripts/smoke.mjs', '--dev'],
  'smoke-media': ['scripts/media-smoke.mjs'],
  'smoke-notes': ['scripts/notes-smoke.mjs'],
  'smoke-standalone': ['scripts/standalone-smoke.mjs'],
  'smoke-standalone-workspace': ['scripts/standalone-smoke.mjs', '--workspace-only'],
  'smoke-standalone-polish': ['scripts/standalone-smoke.mjs', '--polish-only'],
  'smoke-standalone-documents': ['scripts/standalone-smoke.mjs', '--documents-only'],
  'smoke-workspace-ai': ['scripts/workspace-ai-smoke.mjs'],
  'smoke-polish': ['scripts/polish-smoke.mjs'],
  'smoke-documents': ['scripts/documents-smoke.mjs'],
  'smoke-learning': ['scripts/learning-smoke.mjs'],
  'smoke-video':['scripts/video-smoke.mjs'],
  'smoke-video-packed':['scripts/video-smoke.mjs','--packed'],
  'smoke-chinese': ['scripts/chinese-smoke.mjs'],
  'smoke-chinese-packed': ['scripts/chinese-smoke.mjs', '--packed'],
  'smoke-learning-packed': ['scripts/learning-smoke.mjs', '--packed'],
  'smoke-documents-packed': ['scripts/documents-smoke.mjs', '--packed'],
  'smoke-polish-packed': ['scripts/polish-smoke.mjs', '--packed'],
  'smoke-workspace-ai-packed': ['scripts/workspace-ai-smoke.mjs', '--packed'],
  'smoke-notes-dev': ['scripts/notes-smoke.mjs', '--dev'],
  'smoke-notes-real': ['scripts/notes-smoke.mjs', '--real-vault'],
  'smoke-notes-real-packed': ['scripts/notes-smoke.mjs', '--packed', '--real-vault'],
  'smoke-notes-packed': ['scripts/notes-smoke.mjs', '--packed'],
  'smoke-media-dev': ['scripts/media-smoke.mjs', '--dev'],
  'smoke-packed': ['scripts/media-smoke.mjs', '--packed'],
  'smoke-bilibili': ['scripts/bilibili-smoke.mjs'],
  dist: ['node_modules/electron-builder/cli.js', '--win', '--x64', '--config', 'electron-builder.yml'],
  'dist-dir':['node_modules/electron-builder/cli.js','--win','--x64','--dir','--config','electron-builder.yml'],
  'dist-archive':['node_modules/electron-builder/cli.js','--win','--x64','--prepackaged','release/0.10.0/win-unpacked','--config','electron-builder.yml'],
  format: [
    'node_modules/prettier/bin/prettier.cjs',
    '--write',
    'apps/**/*.{ts,tsx,css,html}',
    'tests/**/*.ts',
    'scripts/**/*.mjs',
    'electron.vite.config.ts',
    'tsconfig.json',
    'package.json',
  ],
};
if (!commands[command]) throw new Error('未知命令：' + command);
const [entry, ...args] = commands[command];
const child = spawn(process.execPath, [resolve(root, entry), ...args], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
