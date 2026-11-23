import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../apps/desktop/src/core/storage';

test('Atomic JSON retries transient sharing locks; permanent denial preserves old data and cleans its temp file', async (t) => {
  const root = await fs.mkdtemp(path.resolve('.cache/atomic-sharing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'progress.json');
  await atomicJson(target, { position: 10 });
  const rename = fs.rename.bind(fs);
  let attempts = 0;
  const mock = t.mock.method(fs, 'rename', async (from: string, to: string) => {
    assert.deepEqual(JSON.parse(await fs.readFile(to, 'utf8')), { position: 10 });
    if (++attempts <= 2) throw Object.assign(new Error('temporary sharing lock'), { code: 'EPERM' });
    await rename(from, to);
  });
  await atomicJson(target, { position: 25 });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { position: 25 });
  mock.mock.restore();
  attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw Object.assign(new Error('permanent lock'), { code: 'EACCES' }); });
  await assert.rejects(atomicJson(target, { position: 50 }), /permanent lock/);
  assert.equal(attempts, 6);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { position: 25 });
  assert.deepEqual(await fs.readdir(root), ['progress.json']);
});
