import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, type TestContext } from 'node:test';
import type { ContextAnchor } from '../apps/desktop/src/shared/contracts';

const temporaryWorkspaces = new Set<string>();
after(async () => {
  const base = path.resolve('.cache', 'tests');
  for (const root of temporaryWorkspaces) {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(base + path.sep));
    assert.equal((await fs.lstat(absolute)).isSymbolicLink(), false);
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
export async function workspace(_t: TestContext): Promise<string> {
  const base = path.resolve('.cache', 'tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'core-'));
  temporaryWorkspaces.add(root);
  return root;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
export function anchor(sourceId = 'source-a'): ContextAnchor {
  const now = new Date().toISOString();
  return Object.freeze({
    requestId: 'test-request',
    sourceId,
    sourceTitle: '课程A',
    sourceUrl: 'https://example.com/a',
    visitId: 'visit-a',
    generation: 1,
    mediaTime: 30,
    submittedAt: now,
    evidenceCutoffAt: now,
  });
}
