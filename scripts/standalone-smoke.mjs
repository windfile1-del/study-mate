import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = process.cwd(),
  parent = 'D:\\StudyMateAcceptance';
const workspaceOnly = process.argv.includes('--workspace-only');
const polishOnly = process.argv.includes('--polish-only');
const documentsOnly = process.argv.includes('--documents-only');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const hardlinks = process.env.STUDYMATE_ACCEPTANCE_HARDLINKS === '1';
await fs.mkdir(parent, { recursive: true });
const actualParent = await fs.realpath(parent);
assert.match(actualParent, /^d:\\/i);
const isolated = await fs.mkdtemp(path.join(actualParent, 'study-mate-' + version + '-'));
const appDirectory = path.join(isolated, 'app');
const executable = path.join(appDirectory, 'Study Mate.exe');
assert.ok(
  !path
    .resolve(isolated)
    .toLowerCase()
    .startsWith(root.toLowerCase() + path.sep),
);
const result = { passed: false, isolatedExecutable: executable, cwdOutsideProject: true, results: {} };
result.copyMethod = hardlinks
  ? 'independent file hierarchy with hardlinked immutable package files'
  : 'physical copy';
try {
  const original = path.join(root, 'release', version, 'win-unpacked');
  async function linkTree(source, target) {
    const stat = await fs.lstat(source);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      for (const name of await fs.readdir(source))
        await linkTree(path.join(source, name), path.join(target, name));
    } else await fs.link(source, target);
  }
  if (hardlinks) await linkTree(original, appDirectory);
  else
    await fs.cp(original, appDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  for (const name of documentsOnly
    ? ['documents']
    : polishOnly
      ? ['polish']
      : workspaceOnly
        ? ['workspace-ai']
        : ['reader', 'video', 'chinese', 'learning', 'notes', 'media', 'workspace-ai', 'polish', 'documents']) {
    const log = createWriteStream(path.join(root, '.cache/standalone-' + name + '.log'));
    const env = { ...process.env, STUDYMATE_PACKED_EXE: executable };
    const child = spawn(process.execPath, [path.join(root, 'scripts', name + '-smoke.mjs'), '--packed'], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    await new Promise((resolve) => log.end(resolve));
    const details = JSON.parse(
      await fs.readFile(path.join(root, 'artifacts', name + '-packed/result.json'), 'utf8'),
    );
    result.results[name] = {
      passed: code === 0 && details.passed,
      checks: details.checks.length,
      performance: details.performance,
    };
    if (!result.results[name].passed)
      throw new Error(name + '独立包验证未通过：' + (details.error || '查看.cache中的验收日志'));
  }
  result.passed = true;
} catch (error) {
  result.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  // Delete only the fresh test copy after checking its real absolute boundary.
  if (result.passed && !hardlinks) {
    const actual = await fs.realpath(isolated);
    assert.ok(actual.toLowerCase().startsWith(actualParent.toLowerCase() + path.sep));
    assert.equal((await fs.lstat(actual)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
    result.temporaryCopyRemoved = true;
  }
  if (hardlinks) {
    result.temporaryCopyRemoved = false;
    result.temporaryCopyRetainedReason =
      'Disk-conserving immutable hardlinks; keep outside-project acceptance directory.';
  }
  const output = path.join(
    root,
    documentsOnly
      ? 'artifacts/standalone-documents'
      : polishOnly
        ? 'artifacts/standalone-polish'
        : workspaceOnly
          ? 'artifacts/standalone-workspace'
          : 'artifacts/standalone',
  );
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
