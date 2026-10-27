import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { ContextAnchor, LearningSource, ObservationBinding, PlaybackState } from '../shared/contracts';
import { AppError } from './errors';
import { atomicJson, readJson, SerialQueue } from './storage';

const sensitive = /^(token|cookie|authorization|auth|access_key|sessdata|bili_jct|dedeuserid)$/i;
export function normalizeWebUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('INVALID_URL', '请输入完整的 http 或 https 网页地址。');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('INVALID_URL', '仅支持不含用户名和密码的 http / https 网页地址。');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.delete(key);
  return url.toString();
}
export function identifySource(
  input: string,
): Pick<LearningSource, 'kind' | 'canonicalKey' | 'url' | 'platformVideoId' | 'partIndex'> {
  const url = new URL(normalizeWebUrl(input));
  const bvid = /\/video\/(BV[a-zA-Z0-9]+)/i.exec(url.pathname)?.[1];
  if ((url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) && bvid) {
    const partIndex = Math.max(1, Number.parseInt(url.searchParams.get('p') || '1', 10) || 1);
    return {
      kind: 'bilibili',
      canonicalKey: 'bilibili:' + bvid + ':part:' + partIndex,
      platformVideoId: bvid,
      partIndex,
      url: 'https://www.bilibili.com/video/' + bvid + '/?p=' + partIndex,
    };
  }
  return { kind: 'web', canonicalKey: url.toString(), url: url.toString() };
}
export class SourceRegistry extends EventEmitter {
  private sources = new Map<string, LearningSource>();
  private current: ObservationBinding | null = null;
  private generation = 0;
  private sequences = new Map<string, number>();
  private queue = new SerialQueue();
  private persistenceError: unknown;
  constructor(private readonly stateFile: string) {
    super();
  }
  async initialize(): Promise<void> {
    const saved = await readJson<LearningSource[]>(this.stateFile, []);
    if (!Array.isArray(saved)) throw new AppError('STORAGE_CORRUPT', '学习来源列表格式不正确。');
    for (const source of saved) {
      if (!source?.id || !source.url || !source.canonicalKey)
        throw new AppError('STORAGE_CORRUPT', '学习来源记录缺少必要字段。');
      this.sources.set(source.id, source);
    }
  }
  bind(input: string): ObservationBinding {
    const identity = identifySource(input);
    const id = createHash('sha256').update(identity.canonicalKey).digest('hex').slice(0, 24);
    const now = new Date().toISOString();
    const existing = this.sources.get(id);
    this.sources.set(id, {
      ...identity,
      id,
      title:
        existing?.title ||
        (identity.platformVideoId ? 'B站课程 · ' + identity.platformVideoId : new URL(identity.url).hostname),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    this.current = Object.freeze({
      sourceId: id,
      visitId: randomUUID(),
      generation: ++this.generation,
      url: identity.url,
    });
    this.sequences.clear();
    this.persist();
    this.emit('changed');
    return this.current;
  }
  clear(): void {
    this.current = null;
    this.sequences.clear();
    this.emit('changed');
  }
  bindLocal(file: string, revision: string): ObservationBinding {
    const canonicalKey = 'local:' + path.resolve(file).toLowerCase() + ':' + revision;
    const id = createHash('sha256').update(canonicalKey).digest('hex').slice(0, 24);
    const now = new Date().toISOString();
    this.sources.set(id, {
      id,
      kind: 'local-video',
      canonicalKey,
      url: 'study-local:' + id,
      localPath: file,
      title: path.basename(file),
      createdAt: this.sources.get(id)?.createdAt || now,
      updatedAt: now,
    });
    this.current = Object.freeze({
      sourceId: id,
      visitId: randomUUID(),
      generation: ++this.generation,
      url: 'study-local:' + id,
    });
    this.sequences.clear();
    this.persist();
    this.emit('changed');
    return this.current;
  }
  get active(): ObservationBinding | null {
    return this.current ? { ...this.current } : null;
  }
  get(id: string): LearningSource {
    const source = this.sources.get(id);
    if (!source) throw new AppError('SOURCE_NOT_FOUND', '该学习来源不存在。');
    return { ...source };
  }
  list(): LearningSource[] {
    return [...this.sources.values()]
      .map((s) => ({ ...s }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  accepts(binding: ObservationBinding, url: string, seq: number): void {
    if (
      !this.current ||
      binding.sourceId !== this.current.sourceId ||
      binding.visitId !== this.current.visitId ||
      binding.generation !== this.current.generation
    ) {
      throw new AppError('STALE_SOURCE', '页面已经切换，过期的观察数据已忽略。');
    }
    const source = this.get(binding.sourceId);
    if (
      source.kind === 'local-video'
        ? url !== source.url
        : identifySource(url).canonicalKey !== source.canonicalKey
    ) {
      throw new AppError('SOURCE_MISMATCH', '观察数据与当前学习来源不一致。');
    }
    if (seq <= (this.sequences.get(binding.visitId) ?? -1))
      throw new AppError('STALE_SEQUENCE', '重复或乱序的观察数据已忽略。');
    this.sequences.set(binding.visitId, seq);
  }
  setTitle(sourceId: string, title: string): void {
    const source = this.sources.get(sourceId);
    const clean = title.trim().slice(0, 500);
    if (!source || !clean || clean === source.title) return;
    source.title = clean;
    source.updatedAt = new Date().toISOString();
    this.persist();
    this.emit('changed');
  }
  freeze(playback: PlaybackState | null): ContextAnchor {
    if (!this.current || !playback || playback.sourceId !== this.current.sourceId) {
      throw new AppError('NO_CONTEXT', '请先打开含视频的页面，等待播放进度同步后再读取上下文。');
    }
    const source = this.get(this.current.sourceId);
    const now = new Date().toISOString();
    return Object.freeze({
      requestId: randomUUID(),
      sourceId: source.id,
      sourceTitle: source.title,
      sourceUrl: source.url,
      visitId: this.current.visitId,
      generation: this.current.generation,
      mediaTime: playback.currentTime,
      submittedAt: now,
      evidenceCutoffAt: now,
    });
  }
  private persist(): void {
    const snapshot = this.list();
    void this.queue
      .run(() => atomicJson(this.stateFile, snapshot))
      .catch((error) => {
        this.persistenceError = error;
      });
  }
  async flush(): Promise<void> {
    await this.queue.flush();
    if (this.persistenceError) throw this.persistenceError;
  }
}
