import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { NoteInkService } from '../apps/desktop/src/core/note-ink';
import { NoteSync } from '../apps/desktop/src/core/note-sync';
import { RemoteHost, type RemoteBackend } from '../apps/desktop/src/core/remote-host';
import { VaultService } from '../apps/desktop/src/core/vault';
import type { SharedHandwritingPad } from '../apps/desktop/src/shared/note-ink';
import type { RemoteChatState } from '../apps/desktop/src/shared/remote';
import { workspace } from './helpers';

const encryptionKey = randomBytes(32);
const protection = {
  encrypt: (text: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const data = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  },
  decrypt: (text: string) => {
    const data = Buffer.from(text, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString();
  },
};

function samplePad(overrides: Partial<SharedHandwritingPad>): SharedHandwritingPad {
  const now = Date.now();
  return {
    id: overrides.id ?? `pad-${randomUUID()}`,
    title: overrides.title ?? '推导栏',
    anchorType: overrides.anchorType ?? 'block',
    anchorHeadingId: overrides.anchorHeadingId ?? 'sec-1',
    anchorHeadingText: overrides.anchorHeadingText ?? '第一节',
    anchorBlockIndex: overrides.anchorBlockIndex ?? 2,
    anchorBlockText: overrides.anchorBlockText ?? '核心定理内容',
    anchorBlockOffset: overrides.anchorBlockOffset ?? 1,
    logicalHeight: overrides.logicalHeight ?? 480,
    background: overrides.background ?? 'grid',
    collapsed: overrides.collapsed ?? false,
    strokes: overrides.strokes ?? [
      {
        id: 'st-1',
        tool: 'fountain',
        color: '#0F172A',
        width: 3.8,
        opacity: 1,
        pressureSensitivity: 1,
        points: [
          { x: 100, y: 80, p: 0.4, t: 0 },
          { x: 220, y: 140, p: 0.8, t: 24 },
        ],
      },
    ],
    createdAt: overrides.createdAt ?? now - 1000,
    updatedAt: overrides.updatedAt ?? now,
    ...(overrides.deletedAt ? { deletedAt: overrides.deletedAt } : {}),
  };
}

function httpsJson(
  port: number,
  route: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: body !== undefined ? 'POST' : 'GET',
        rejectUnauthorized: false,
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('NoteInkService merges tablet and desktop pads without overwriting and propagates tombstones', async (t) => {
  const dir = await workspace(t);
  const service = new NoteInkService(dir);
  const vaultId = 'vault-alpha';
  const notePath = 'math/calculus.md';
  const now = Date.now();

  const desktopPad = samplePad({ id: 'pad-desktop', title: '桌面手写', createdAt: now - 500, updatedAt: now - 200 });
  const tabletPad = samplePad({ id: 'pad-tablet', title: '平板手写', createdAt: now - 400, updatedAt: now - 100 });

  await service.save(vaultId, notePath, [desktopPad]);
  const synced = await service.syncNote(vaultId, notePath, [tabletPad]);
  assert.equal(synced.changed, true);
  assert.deepEqual(
    synced.pads.map((p) => p.id),
    ['pad-desktop', 'pad-tablet'],
    'syncing tablet pad must preserve desktop pad and merge both',
  );

  // Deleting pad-desktop with a newer tombstone propagates and survives stale saves
  const tombstone = samplePad({
    id: 'pad-desktop',
    title: '桌面手写',
    createdAt: now - 500,
    updatedAt: now + 50,
    deletedAt: now + 50,
    strokes: [],
  });
  const afterDelete = await service.syncNote(vaultId, notePath, [tombstone]);
  assert.equal(afterDelete.pads.find((p) => p.id === 'pad-desktop')?.deletedAt, now + 50);

  // Stale client sending older version of pad-desktop cannot resurrect it
  const staleResync = await service.syncNote(vaultId, notePath, [desktopPad]);
  assert.equal(staleResync.pads.find((p) => p.id === 'pad-desktop')?.deletedAt, now + 50);
  assert.equal(staleResync.pads.find((p) => p.id === 'pad-tablet')?.title, '平板手写');
});

test('RemoteHost exposes authenticated /v1/notes/ink/sync and /v1/notes/ink/sync-all endpoints', async (t) => {
  const dir = await workspace(t);
  const vaultDir = path.join(dir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'lesson.md'), '# 第一课\n\n重点推导\n', 'utf8');
  const vault = await VaultService.open(vaultDir, path.join(dir, 'vault-state'));
  t.after(() => vault.close());
  const noteInk = new NoteInkService(dir);

  const chat: RemoteChatState = {
    conversationId: randomUUID(),
    conversations: [],
    messages: [],
    busy: false,
    model: 'fixture',
    notice: '',
  };

  const backend: RemoteBackend = {
    vaultId: () => vault.id,
    snapshot: async () => ({ vaultId: vault.id }),
    notes: () => vault.list(),
    note: (p) => vault.read(p),
    syncNoteInk: async (p, pads) => {
      await vault.resolveNotePath(p);
      return noteInk.syncNote(vault.id, p, pads);
    },
    syncVaultInk: async (notes) => noteInk.syncVault(vault.id, notes),
    resolve: (b, target, w) => vault.resolveLink(b, target, w),
    image: async () => ({ bytes: Buffer.from('img'), mime: 'image/png' }),
    search: async () => [],
    chat: async () => chat,
    send: async () => {},
    conversation: async () => chat,
    cancel: async () => {},
  };

  const host = new RemoteHost(dir, backend, protection);
  await host.initialize();
  await host.start('127.0.0.1', true);
  t.after(() => host.stop());

  const port = host.state().port;
  const hello = await httpsJson(port, '/v1/hello', '');
  assert.equal(hello.status, 200);
  assert.equal(hello.json.capabilities.noteInkSync, true);

  // Pair a tablet device
  const pairCode = host.auth.issueCode(['127.0.0.1'], port);
  const pending = host.auth.begin(pairCode.secret, 'Galaxy Tab S8+');
  await host.auth.approve(pending.pairingId, vault.id);
  const approved = host.auth.poll(pending.pairingId, pending.pollToken) as { accessToken: string };

  // Unauthenticated sync rejected
  const unauth = await httpsJson(port, '/v1/notes/ink/sync', '', { path: 'lesson.md', pads: [] });
  assert.equal(unauth.status, 401);

  // Seed desktop pad, then tablet syncs its own pad -> both preserved!
  const now = Date.now();
  const deskPad = samplePad({ id: 'pad-desk-1', title: '电脑批注', createdAt: now - 300, updatedAt: now - 200 });
  const tabPad = samplePad({ id: 'pad-tab-1', title: 'S-Pen 推导', createdAt: now - 100, updatedAt: now - 50 });
  await noteInk.save(vault.id, 'lesson.md', [deskPad]);

  const syncRes = await httpsJson(port, '/v1/notes/ink/sync', approved.accessToken, {
    path: 'lesson.md',
    pads: [tabPad],
  });
  assert.equal(syncRes.status, 200);
  assert.deepEqual(
    syncRes.json.pads.map((p: SharedHandwritingPad) => p.id),
    ['pad-desk-1', 'pad-tab-1'],
  );

  // Bulk sync-all merges across vault
  const syncAllRes = await httpsJson(port, '/v1/notes/ink/sync-all', approved.accessToken, {
    notes: {
      'lesson.md': [
        samplePad({ id: 'pad-tab-2', title: '离线新增', createdAt: now, updatedAt: now + 10 }),
      ],
    },
  });
  assert.equal(syncAllRes.status, 200);
  assert.equal(syncAllRes.json.notes['lesson.md'].length, 3);
});

test('NoteSync bidirectionally merges tablet Drive handwriting pads into Desktop NoteInkService', async (t) => {
  const dir = await workspace(t);
  const vaultDir = path.join(dir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'linear.md'), '# 线性代数\n\n核心公式\n', 'utf8');

  const vault = await VaultService.open(vaultDir, path.join(dir, 'vault-state'));
  t.after(() => vault.close());
  const noteInk = new NoteInkService(dir);
  const now = Date.now();
  const tabletDrivePad = samplePad({ id: 'pad-from-drive', title: '平板离线手写', createdAt: now - 100, updatedAt: now });

  let publishedSnapshots = 0;
  let driveSyncedSource = '';
  const fakeDrive = {
    account: async () => 'student@example.com',
    connect: async () => {},
    disconnect: async () => {},
    publish: async () => {
      publishedSnapshots++;
    },
    syncInk: async (source: string, localNotes: Record<string, SharedHandwritingPad[]>) => {
      driveSyncedSource = source;
      return {
        ...localNotes,
        'linear.md': [...(localNotes['linear.md'] ?? []), tabletDrivePad],
      };
    },
  };

  const sync = new NoteSync(dir, () => vault, fakeDrive, noteInk);
  await sync.control({ action: 'select', path: 'linear.md', enabled: true });
  await sync.close();

  assert.ok(publishedSnapshots >= 1);
  assert.ok(driveSyncedSource.length > 0);
  const loaded = await noteInk.load(vault.id, 'linear.md');
  assert.deepEqual(
    loaded.pads.map((p) => p.id),
    ['pad-from-drive'],
    'Desktop must pull and preserve tablet handwriting pads from Drive instead of overwriting them',
  );
});
