import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemotePlaybackStore } from '../apps/desktop/src/core/remote-playback';
import { playbackProgress, playbackHandoff, type RemoteDevice } from '../apps/desktop/src/shared/remote';

test('Tablet checkpoints reject stale sessions, tolerate out-of-order packets, isolate devices and survive restart', async (t) => {
  const root = await fs.mkdtemp(path.resolve('.cache/remote-playback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RemotePlaybackStore(root); await store.initialize();
  const d: RemoteDevice = { id: randomUUID(), name: '三星平板', vaultId: 'v1', createdAt: '', lastSeenAt: '', revoked: false };
  const other = { ...d, id: randomUUID() }, sourceId = 'a'.repeat(24);
  const { sessionId } = await store.start(d, sourceId);
  const p = { sourceId, sessionId, sequence: 5, position: 120, duration: 500, rate: 1.5 };
  await store.save(d, p);
  await store.save(d, { ...p, sequence: 4, position: 30 });
  assert.equal(store.checkpoint(d, sourceId)?.position, 120);
  await assert.rejects(store.save(other, p), /重新打开/);
  assert.equal(store.checkpoint(other, sourceId), null);
  assert.equal(store.checkpoint({ ...d, vaultId: 'v2' }, sourceId), null);
  const next = await store.start(d, sourceId);
  assert.equal(next.checkpoint?.position, 120);
  await assert.rejects(store.save(d, { ...p, sequence: 6 }), /重新打开/);
  // Backward seeks with a newer sequence must be saved, rather than taking max(position).
  await store.save(d, { ...p, sessionId: next.sessionId, sequence: 0, position: 15 });
  const restored = new RemotePlaybackStore(root); await restored.initialize();
  assert.equal(restored.checkpoint(d, sourceId)?.position, 15);
  await assert.rejects(restored.save(d, { ...p, sessionId: next.sessionId }), /重新打开/);
});

test('Handoff freezes the click position, requires current vault/device, persists and cannot replay after dismissal', async (t) => {
  const root = await fs.mkdtemp(path.resolve('.cache/remote-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RemotePlaybackStore(root); await store.initialize();
  const d: RemoteDevice = { id: randomUUID(), name: '平板', vaultId: 'v', createdAt: '', lastSeenAt: '', revoked: false };
  const sourceId = 'b'.repeat(24), { sessionId } = await store.start(d, sourceId);
  const p = { sourceId, sessionId, sequence: 1, position: 20, duration: 900, rate: 2, requestId: randomUUID() };
  await store.offer(d, p, '课程');
  await store.save(d, { ...p, sequence: 2, position: 300 });
  assert.equal((await store.offer(d, p, '课程')).position, 20);
  assert.equal(store.pending('v', [d])[0].position, 20);
  assert.deepEqual(store.pending('other', [d]), []);
  assert.deepEqual(store.pending('v', [{ ...d, revoked: true }]), []);
  assert.deepEqual(store.pending('v', [{ ...d, vaultId: 'other' }]), []);
  const restored = new RemotePlaybackStore(root); await restored.initialize();
  assert.equal(restored.pending('v', [d])[0].rate, 2);
  await store.dismiss(p.requestId);
  await assert.rejects(store.offer(d, p, '课程'), /已处理/);
  await restored.initialize(); assert.deepEqual(restored.pending('v', [d]), []);
  assert.equal(playbackProgress.safeParse({ ...p, requestId: undefined }).success, false);
  assert.equal(playbackProgress.safeParse({ sourceId, sessionId, sequence: 0, position: 999, duration: 500, rate: 1 }).success, false);
  assert.equal(playbackHandoff.safeParse({ ...p, rate: 50 }).success, false);
  assert.equal(playbackHandoff.safeParse({ ...p, cookie: 'no' }).success, false);
});
