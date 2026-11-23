import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  handwritingPadListSchema,
  mergeHandwritingPads,
  NOTE_INK_MAX_BYTES,
  type NoteInkResponse,
  type SharedHandwritingPad,
} from '../shared/note-ink';
import { AppError } from './errors';
import { atomicJson, readJson, SerialQueue } from './storage';

interface StoredNoteInk {
  schema: 1;
  vaultId: string;
  path: string;
  updatedAt: number;
  pads: SharedHandwritingPad[];
}

function normalizeNotePath(raw: string): string {
  const clean = raw.replaceAll('\\', '/').replace(/^\/+/, '').trim();
  if (!clean || clean.length > 500 || clean.includes('\0')) {
    throw new AppError('INVALID_INPUT', '笔记路径无效。');
  }
  return clean;
}

function safeSegment(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
  if (!clean) throw new AppError('INVALID_INPUT', '知识库标识无效。');
  return clean;
}

function noteHash(notePath: string): string {
  return createHash('sha256').update(notePath, 'utf8').digest('hex');
}

export class NoteInkService extends EventEmitter {
  private readonly queue = new SerialQueue();

  constructor(private readonly dataDir: string) {
    super();
  }

  private vaultDir(vaultId: string): string {
    return path.join(this.dataDir, 'state', 'note-ink', safeSegment(vaultId));
  }

  private noteFile(vaultId: string, notePath: string): string {
    return path.join(this.vaultDir(vaultId), noteHash(normalizeNotePath(notePath)) + '.json');
  }

  private async readStored(vaultId: string, notePath: string): Promise<StoredNoteInk> {
    const cleanPath = normalizeNotePath(notePath);
    const fallback: StoredNoteInk = { schema: 1, vaultId, path: cleanPath, updatedAt: 0, pads: [] };
    const stored = await readJson<StoredNoteInk>(this.noteFile(vaultId, cleanPath), fallback);
    if (!stored || !Array.isArray(stored.pads)) return fallback;
    const parsed = handwritingPadListSchema.safeParse(stored.pads);
    return {
      schema: 1,
      vaultId,
      path: cleanPath,
      updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0,
      pads: parsed.success ? parsed.data : [],
    };
  }

  private async writeStored(record: StoredNoteInk): Promise<void> {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > NOTE_INK_MAX_BYTES) {
      throw new AppError('INVALID_INPUT', '单篇笔记手写数据超过 2 MiB 限制。');
    }
    const target = this.noteFile(record.vaultId, record.path);
    if (record.pads.length === 0) {
      await fs.unlink(target).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      return;
    }
    await atomicJson(target, record);
  }

  async load(vaultId: string, notePath: string): Promise<NoteInkResponse> {
    const cleanPath = normalizeNotePath(notePath);
    const stored = await this.queue.run(() => this.readStored(vaultId, cleanPath));
    return {
      vaultId,
      path: cleanPath,
      pads: stored.pads,
      updatedAt: stored.updatedAt,
    };
  }

  async save(vaultId: string, notePath: string, incoming: unknown): Promise<NoteInkResponse> {
    const cleanPath = normalizeNotePath(notePath);
    const validated = handwritingPadListSchema.parse(incoming);
    return this.syncNoteInternal(vaultId, cleanPath, validated, true);
  }

  async syncNote(
    vaultId: string,
    notePath: string,
    incoming: unknown,
  ): Promise<NoteInkResponse & { changed: boolean }> {
    const cleanPath = normalizeNotePath(notePath);
    const validated = handwritingPadListSchema.parse(incoming);
    return this.syncNoteInternal(vaultId, cleanPath, validated, true);
  }

  private async syncNoteInternal(
    vaultId: string,
    cleanPath: string,
    incoming: SharedHandwritingPad[],
    emitChange: boolean,
  ): Promise<NoteInkResponse & { changed: boolean }> {
    const result = await this.queue.run(async () => {
      const existing = await this.readStored(vaultId, cleanPath);
      const merged = mergeHandwritingPads(existing.pads, incoming);
      const changed = JSON.stringify(existing.pads) !== JSON.stringify(merged);
      const updatedAt = changed ? Date.now() : existing.updatedAt;
      if (changed) {
        await this.writeStored({
          schema: 1,
          vaultId,
          path: cleanPath,
          updatedAt,
          pads: merged,
        });
      }
      return {
        vaultId,
        path: cleanPath,
        pads: merged,
        updatedAt,
        changed,
      };
    });
    if (result.changed && emitChange) {
      this.emit('changed', { vaultId, path: cleanPath });
    }
    return result;
  }

  async listVault(vaultId: string): Promise<Record<string, SharedHandwritingPad[]>> {
    return this.queue.run(() => this.listVaultUnlocked(vaultId));
  }

  private async listVaultUnlocked(vaultId: string): Promise<Record<string, SharedHandwritingPad[]>> {
    const dir = this.vaultDir(vaultId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    const notes: Record<string, SharedHandwritingPad[]> = {};
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const stored = await readJson<StoredNoteInk | null>(path.join(dir, file), null);
      if (!stored || typeof stored.path !== 'string' || !Array.isArray(stored.pads)) continue;
      const parsed = handwritingPadListSchema.safeParse(stored.pads);
      if (parsed.success && parsed.data.length > 0) {
        notes[normalizeNotePath(stored.path)] = parsed.data;
      }
    }
    return notes;
  }

  async syncVault(
    vaultId: string,
    incomingNotes: Record<string, unknown>,
  ): Promise<{ vaultId: string; notes: Record<string, SharedHandwritingPad[]>; changed: boolean; updatedAt: number }> {
    const entries = Object.entries(incomingNotes);
    if (entries.length > 100) {
      throw new AppError('INVALID_INPUT', '单次最多同步 100 篇笔记的手写栏。');
    }
    const validatedNotes: Array<[string, SharedHandwritingPad[]]> = entries.map(([rawPath, rawPads]) => [
      normalizeNotePath(rawPath),
      handwritingPadListSchema.parse(rawPads),
    ]);

    const { notes, changedPaths, updatedAt } = await this.queue.run(async () => {
      const changedPaths: string[] = [];
      const now = Date.now();
      for (const [cleanPath, incomingPads] of validatedNotes) {
        const existing = await this.readStored(vaultId, cleanPath);
        const merged = mergeHandwritingPads(existing.pads, incomingPads, now);
        if (JSON.stringify(existing.pads) !== JSON.stringify(merged)) {
          await this.writeStored({
            schema: 1,
            vaultId,
            path: cleanPath,
            updatedAt: now,
            pads: merged,
          });
          changedPaths.push(cleanPath);
        }
      }
      const allNotes = await this.listVaultUnlocked(vaultId);
      return { notes: allNotes, changedPaths, updatedAt: now };
    });

    if (changedPaths.length > 0) {
      for (const p of changedPaths) {
        this.emit('changed', { vaultId, path: p });
      }
    }
    return { vaultId, notes, changed: changedPaths.length > 0, updatedAt };
  }
}
