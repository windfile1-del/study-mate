import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { compileNote } from '../renderer/notes/markdown';
import { NOTE_SYNC_LIMIT, type NoteSyncControl, type NoteSyncState, type ReadingSnapshot } from '../shared/note-sync';
import type { SharedHandwritingPad } from '../shared/note-ink';
import { AppError } from './errors';
import type { NoteInkService } from './note-ink';
import { atomicJson, readJson, SerialQueue } from './storage';
import type { VaultService } from './vault';

interface DriveWriter {
  account(): Promise<string>;
  connect(credential: string): Promise<void>;
  disconnect(): Promise<void>;
  publish(snapshot: ReadingSnapshot): Promise<void>;
  syncInk?(
    source: string,
    localNotes: Record<string, SharedHandwritingPad[]>,
  ): Promise<Record<string, SharedHandwritingPad[]> | null>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const mime: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
};
type Settings = { source: string; paths: string[]; revision: number; fingerprint: string };
type MarkdownNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };

export class NoteSync {
  private readonly queue = new SerialQueue();
  private readonly cloudQueue = new SerialQueue();
  private timer?: ReturnType<typeof setInterval>;
  private pending = false;
  private scanAfter = 0;
  private cached?: { vaultId: string; snapshot: ReadingSnapshot };
  private uploaded = new Map<string, number>();
  private failure = '';
  private cloudFailure = '';
  private nextUpload?: { snapshot: ReadingSnapshot; vaultId: string };
  private uploading = false;

  constructor(
    private dataDir: string,
    private vault: () => VaultService,
    private drive: DriveWriter,
    private noteInk?: NoteInkService,
  ) {}

  start() {
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 30_000);
    this.timer.unref();
  }

  async close() {
    clearInterval(this.timer);
    await this.queue.flush();
    await this.cloudQueue.flush();
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    void this.queue.run(async () => {
      try { await this.update(this.vault()); this.failure = ''; }
      catch (error) { this.failure = error instanceof Error ? error.message : '同步失败。'; }
      finally { this.pending = false; }
    });
  }

  private file(vault: VaultService) {
    return path.join(this.dataDir, 'state', 'note-sync', vault.id + '.json');
  }

  private settings(vault: VaultService) {
    return readJson<Settings>(this.file(vault), { source: randomUUID(), paths: [], revision: 0, fingerprint: '' });
  }

  async read(source: string, revision: number) {
    const vault = this.vault();
    const snapshot = this.cached?.vaultId === vault.id && Date.now() < this.scanAfter
      ? this.cached.snapshot
      : await this.queue.run(() => this.snapshot(vault));
    if (this.vault() !== vault) throw new AppError('STALE_VAULT', '电脑已切换知识库。');
    return snapshot.source === source && snapshot.revision === revision ? { unchanged: true } : snapshot;
  }

  async control(input: NoteSyncControl): Promise<NoteSyncState> {
    const vault = this.vault();
    if (input.action === 'drive-connect') {
      // Browser consent may take minutes. Do not block the LAN read queue.
      await this.drive.connect(input.credential);
      this.uploaded.clear();
      this.cloudFailure = '';
      this.schedule();
    } else if (input.action !== 'state') {
      await this.queue.run(async () => {
        if (input.action === 'drive-disconnect') {
          this.nextUpload = undefined;
          await this.cloudQueue.run(async () => {
            await this.drive.disconnect();
            this.uploaded.clear();
            this.cloudFailure = '';
          });
          this.failure = '';
          return;
        }
        if (input.action === 'select') {
          const settings = await this.settings(vault);
          if (input.enabled) await vault.read(input.path);
          const paths = new Set(settings.paths);
          if (input.enabled) paths.add(input.path); else paths.delete(input.path);
          if (paths.size > 100) throw new Error('每个知识库最多选择 100 篇同步笔记。');
          await atomicJson(this.file(vault), { ...settings, paths: [...paths] });
          this.cached = undefined;
        }
        try { await this.update(vault); this.failure = ''; }
        catch (error) { this.failure = error instanceof Error ? error.message : '同步失败。'; }
      });
    }
    const settings = await this.settings(vault);
    const selected = new Set(settings.paths);
    const notes: NoteSyncState['notes'] = [];
    const collect = (rows: Awaited<ReturnType<VaultService['list']>>) => {
      for (const row of rows) {
        if (row.children) collect(row.children);
        else if (/\.md$/i.test(row.path)) notes.push({ path: row.path, selected: selected.delete(row.path) });
      }
    };
    collect(await vault.list());
    for (const missing of selected) notes.push({ path: missing, selected: true });
    return { notes, revision: settings.revision, account: await this.drive.account(),
      uploaded: this.uploaded.get(settings.source) ?? 0, error: this.failure || this.cloudFailure };
  }

  private async update(vault: VaultService) {
    const snapshot = await this.snapshot(vault);
    const needNotes = !!snapshot.revision && this.uploaded.get(snapshot.source) !== snapshot.revision;
    const canSyncInk = !!this.noteInk && typeof this.drive.syncInk === 'function';
    if (!needNotes && !canSyncInk) return;
    this.nextUpload = { snapshot, vaultId: vault.id };
    if (this.uploading) return;
    this.uploading = true;
    void this.cloudQueue.run(async () => {
      try {
        while (this.nextUpload) {
          const next = this.nextUpload;
          this.nextUpload = undefined;
          if (!await this.drive.account()) continue;
          if (next.snapshot.revision && this.uploaded.get(next.snapshot.source) !== next.snapshot.revision) {
            await this.drive.publish(next.snapshot);
            this.uploaded.set(next.snapshot.source, next.snapshot.revision);
          }
          if (this.noteInk && typeof this.drive.syncInk === 'function') {
            const localInk = await this.noteInk.listVault(next.vaultId);
            const merged = await this.drive.syncInk(next.snapshot.source, localInk);
            if (merged && Object.keys(merged).length > 0) {
              await this.noteInk.syncVault(next.vaultId, merged);
            }
          }
          this.cloudFailure = '';
        }
      } catch (error) {
        this.cloudFailure = error instanceof Error ? error.message : 'Google Drive 同步失败。';
      } finally { this.uploading = false; }
    });
  }

  private async snapshot(vault: VaultService): Promise<ReadingSnapshot> {
    const settings = await this.settings(vault);
    const snapshot: ReadingSnapshot = { schema: 1, source: settings.source, revision: settings.revision, notes: [], images: {} };
    const selected = new Set(settings.paths);
    const imagePaths = new Map<string, string>();
    let bytes = 0;
    for (const relative of [...selected].sort()) {
      let note;
      try { note = await vault.read(relative); }
      catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') continue;
        throw error;
      }
      const images: Record<string, string> = Object.create(null);
      const links: ReadingSnapshot['notes'][number]['links'] = Object.create(null);
      const visit = async (node: MarkdownNode): Promise<void> => {
        const isImage = node.tagName === 'img';
        const target = node.properties?.[isImage ? 'src' : 'href'];
        if (typeof target === 'string' && target && (isImage || node.tagName === 'a') && !/^(?:[a-z][\w+.-]*:|\/\/|\\\\)/i.test(target)) {
          const wiki = node.properties?.dataWiki === 'true';
          const key = (wiki ? '1:' : '0:') + target;
          const resolved = await vault.resolveLink(relative, target, wiki).catch(() => null);
          if (resolved && isImage) {
            const file = await vault.imagePath(resolved.path).catch(() => null);
            if (file) {
              let id = imagePaths.get(file);
              if (!id) {
                const data = await fs.readFile(file);
                id = hash(data) + path.extname(file).toLowerCase();
                if (!snapshot.images[id]) {
                  bytes += Math.ceil(data.length / 3) * 4;
                  if (bytes > NOTE_SYNC_LIMIT) throw Error('同步图片超过 24 MiB，请减少所选笔记。');
                  snapshot.images[id] = { data: data.toString('base64'), mime: mime[path.extname(file).toLowerCase()] };
                }
                imagePaths.set(file, id);
              }
              images[key] = id;
            }
          } else if (resolved && selected.has(resolved.path)) links[key] = resolved;
        }
        for (const child of node.children ?? []) await visit(child);
      };
      for (const block of (await compileNote(note.content)).blocks) await visit(block);
      snapshot.notes.push({ ...note, images, links });
      bytes += Buffer.byteLength(note.content);
      if (bytes > NOTE_SYNC_LIMIT) throw Error('同步笔记和图片超过 24 MiB，请减少所选笔记。');
    }
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload) > NOTE_SYNC_LIMIT - 128) throw Error('同步笔记和图片超过 24 MiB，请减少所选笔记。');
    const fingerprint = hash(payload);
    if (settings.fingerprint !== fingerprint) {
      snapshot.revision++;
      await atomicJson(this.file(vault), { ...settings, revision: snapshot.revision,
        fingerprint: hash(JSON.stringify(snapshot)) });
    }
    this.cached = { vaultId: vault.id, snapshot };
    this.scanAfter = Date.now() + 10_000;
    return snapshot;
  }
}
