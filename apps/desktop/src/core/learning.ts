import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TemporalIndex } from '../../../../vendor/video-observer/src/TemporalIndex.mjs';
import { FrameArchive } from '../../../../vendor/video-observer/src/cache/FrameArchive.mjs';
import { SessionStore } from '../../../../vendor/video-observer/src/cache/SessionStore.mjs';
import { BrowserAdapter } from '../../../../vendor/video-observer/src/browser/BrowserAdapter.mjs';
import type { ContextAnchor, LearningContext, ObservationInput, PlaybackState } from '../shared/contracts';
import { SourceRegistry } from './sources';
import { AppError } from './errors';
import type { MediaStore } from './media-store';
import { VideoCacheManager } from './video-cache';

interface LegacyFrame {
  id: string;
  timestamp: number;
  width: number;
  height: number;
  data?: string | null;
  mimeType?: string;
  sceneCut?: boolean;
  cachedAt?: string;
  archivePath?: string;
}
interface LegacySession {
  id: string;
  archiveFrames: LegacyFrame[];
  archiveFrameCount: number;
  subtitles: { range(start: number, end: number): LearningContext['subtitles']; size: number };
  snapshot: unknown;
}
interface LegacyIndex {
  initialize(): Promise<unknown>;
  persist(): Promise<void>;
  ingestSnapshot(value: unknown): unknown;
  ingestSubtitles(value: unknown, session?: LegacySession): number;
  currentSession(): LegacySession | null;
}
interface Runtime {
  index: LegacyIndex;
  archive: FrameArchive;
  session: LegacySession | null;
}
interface FrozenEvidence {
  anchor: ContextAnchor;
  subtitles: LearningContext['subtitles'];
  stale: boolean;
}

export class LearningService extends EventEmitter {
  readonly cache: VideoCacheManager;
  private runtimes = new Map<string, Promise<Runtime>>();
  private resolved = new Map<string, Runtime>();
  private states = new Map<string, PlaybackState>();
  private requests = new Map<string, FrozenEvidence>();
  private closing = false;
  constructor(
    private readonly root: string,
    private readonly sources: SourceRegistry,
    private readonly mediaStore?: MediaStore,
  ) {
    super();
    this.cache = new VideoCacheManager(root, (removed) => {
      for (const [id, runtime] of this.resolved) {
        if (runtime.session) {
          runtime.session.archiveFrames = runtime.session.archiveFrames.filter(
            (f) => !f.archivePath || !removed.has(path.resolve(this.root, id, f.archivePath)),
          );
          runtime.session.archiveFrameCount = runtime.session.archiveFrames.length;
        }
      }
      this.emit('changed');
    });
  }
  private runtime(sourceId: string): Promise<Runtime> {
    let pending = this.runtimes.get(sourceId);
    if (!pending) {
      pending = (async () => {
        const dataDir = path.join(this.root, sourceId);
        const archive = new FrameArchive(dataDir, { clearOnReboot: false });
        const index = new TemporalIndex({
          adapter: new BrowserAdapter(),
          archive,
          sessionStore: new SessionStore(dataDir),
          archiveIntervalMs: 1000,
        }) as unknown as LegacyIndex;
        await index.initialize();
        const runtime = { index, archive, session: index.currentSession() };
        this.resolved.set(sourceId, runtime);
        return runtime;
      })();
      this.runtimes.set(sourceId, pending);
      void pending.catch(() => this.runtimes.delete(sourceId));
    }
    return pending;
  }
  playback(sourceId?: string): PlaybackState | null {
    const id = sourceId || this.sources.active?.sourceId;
    const state = id ? this.states.get(id) : null;
    return state ? { ...state } : null;
  }
  async addSubtitles(sourceId: string, entries: LearningContext['subtitles']) {
    if (this.closing || !entries.length) return;
    const source = this.sources.get(sourceId),
      runtime = await this.runtime(sourceId);
    if (this.closing) return;
    if (!runtime.session) {
      runtime.index.ingestSnapshot({
        url: source.url,
        title: source.title,
        currentTime: 0,
        duration: 0,
        paused: true,
        playbackRate: 1,
        observedAt: new Date().toISOString(),
        frame: null,
        frameStatus: 'not-requested',
      });
      runtime.session = runtime.index.currentSession();
    }
    if (runtime.session) {
      runtime.index.ingestSubtitles({ source: 'subtitle-file', entries }, runtime.session);
      await runtime.index.persist();
      this.emit('changed');
    }
  }
  async observe(input: ObservationInput): Promise<void> {
    this.sources.accepts(input.binding, input.url, input.seq);
    const source = this.sources.get(input.binding.sourceId);
    const runtime = await this.runtime(source.id);
    const observedAt = new Date().toISOString();
    runtime.index.ingestSnapshot({
      url: source.url,
      title: input.title,
      currentTime: input.currentTime,
      duration: input.duration,
      bvid: source.platformVideoId || null,
      cid: null,
      paused: input.paused,
      playbackRate: input.playbackRate,
      observedAt,
      frame: this.cache.state.settings.enabled ? input.frame : null,
      frameStatus: input.frameStatus,
    });
    const session = runtime.index.currentSession();
    runtime.session = session;
    if (input.captions?.length && session)
      runtime.index.ingestSubtitles(
        { source: 'text-track', entries: input.captions.filter((c) => c.to >= c.from) },
        session,
      );
    if (input.subtitle && session) {
      runtime.index.ingestSubtitles(
        {
          source: 'visible-dom',
          entries: [
            {
              from: input.currentTime,
              to: input.currentTime + 2.5,
              text: input.subtitle,
              source: 'visible-dom',
            },
          ],
        },
        session,
      );
    }
    // Keep archived image bytes on disk. Only the bounded ring keeps live pixels.
    if (session) session.archiveFrames = session.archiveFrames.map((frame) => ({ ...frame, data: null }));
    const previous = this.states.get(source.id);
    this.states.set(source.id, {
      sourceId: source.id,
      currentTime: input.currentTime,
      duration: input.duration,
      paused: input.paused,
      playbackRate: input.playbackRate,
      observedAt,
      frameStatus: input.frame
        ? 'captured'
        : previous?.frameStatus === 'captured' && input.frameStatus === 'not-requested'
          ? 'captured'
          : input.frameStatus,
      subtitleCount: session?.subtitles.size || 0,
      frameCount: session?.archiveFrameCount || 0,
    });
    this.sources.setTitle(source.id, input.title);
    this.emit('changed');
  }
  freeze(): ContextAnchor {
    const playback = this.playback();
    const anchor = this.sources.freeze(playback);
    const runtime = this.resolved.get(anchor.sourceId);
    const subtitles = runtime?.session?.subtitles.range(0, Number.MAX_SAFE_INTEGER) || [];
    this.requests.set(anchor.requestId, {
      anchor,
      subtitles: subtitles.map((s) => ({ ...s })),
      stale: !playback || Date.parse(anchor.submittedAt) - Date.parse(playback.observedAt) > 3500,
    });
    if (this.requests.size > 32) this.requests.delete(this.requests.keys().next().value!);
    return anchor;
  }
  async context(anchor: ContextAnchor, signal?: AbortSignal): Promise<LearningContext> {
    const frozen = this.requests.get(anchor.requestId);
    if (!frozen || JSON.stringify(frozen.anchor) !== JSON.stringify(anchor))
      throw new AppError('CONTEXT_EXPIRED', '该请求上下文已过期，请重新读取。');
    signal?.throwIfAborted();
    const runtime = await this.runtime(anchor.sourceId);
    await runtime.index.persist();
    signal?.throwIfAborted();
    const session = runtime.session;
    const frames = (
      await this.frames(anchor, Math.max(0, anchor.mediaTime - 30), anchor.mediaTime, 3, signal)
    ).frames;
    signal?.throwIfAborted();
    const native =
      (await this.mediaStore?.nearby(anchor.sourceId, anchor.mediaTime, anchor.evidenceCutoffAt)) || [];
    const selected = ([...frames, ...native] as LegacyFrame[])
      .filter((f) => !f.cachedAt || Date.parse(f.cachedAt) <= Date.parse(anchor.evidenceCutoffAt))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-6);
    const gaps: string[] = [];
    if (!selected.length) gaps.push('此时间范围尚未缓存画面。');
    const subtitles = this.subtitles(anchor, Math.max(0, anchor.mediaTime - 90), anchor.mediaTime);
    if (!subtitles.length) gaps.push('此时间范围没有已取得的字幕；若已开启采音，可按需读取转写。');
    if (frozen.stale) gaps.push('播放器状态已过期，此处显示最后一次记录的位置。');
    return {
      anchor,
      stale: frozen.stale,
      subtitles,
      gaps,
      frames: selected.map((f) => ({
        id: f.id,
        timestamp: f.timestamp,
        width: f.width,
        height: f.height,
        sceneCut: Boolean(f.sceneCut),
        data: !f.data
          ? null
          : f.data.startsWith('data:')
            ? f.data
            : 'data:' + (f.mimeType || 'image/webp') + ';base64,' + f.data,
      })),
    };
  }
  private frozen(anchor: ContextAnchor) {
    const value = this.requests.get(anchor.requestId);
    if (!value || JSON.stringify(value.anchor) !== JSON.stringify(anchor))
      throw new AppError('CONTEXT_EXPIRED', '提问来源已过期，请重新发送问题。');
    return value;
  }
  subtitles(anchor: ContextAnchor, start: number, end: number, query = '', limit = 100) {
    const rows = this.frozen(anchor).subtitles.filter((s) => s.to >= start && s.from <= end);
    const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return rows
      .filter((s) => !tokens.length || tokens.every((t) => s.text.toLocaleLowerCase().includes(t)))
      .slice(0, Math.min(100, limit))
      .map((s) => ({ ...s }));
  }
  async frames(anchor: ContextAnchor, start: number, end: number, count = 3, signal?: AbortSignal) {
    this.frozen(anchor);
    signal?.throwIfAborted();
    const runtime = await this.runtime(anchor.sourceId);
    await runtime.index.persist();
    await Promise.all([...runtime.archive.queues.values()]);
    signal?.throwIfAborted();
    const available = (runtime.session?.archiveFrames || [])
      .filter(
        (f) =>
          f.timestamp >= start && f.timestamp <= end && !!f.cachedAt && f.cachedAt <= anchor.evidenceCutoffAt,
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    const selected: LegacyFrame[] = [];
    for (let i = 0; i < count && available.length; i++) {
      const target = count === 1 ? (start + end) / 2 : start + ((end - start) * i) / (count - 1);
      const nearest = available.reduce((a, b) =>
        Math.abs(a.timestamp - target) <= Math.abs(b.timestamp - target) ? a : b,
      );
      if (!selected.some((f) => f.id === nearest.id)) selected.push(nearest);
    }
    const loaded = (await Promise.all(selected.map((f) => runtime.archive.readFrame(f)))).filter(
      Boolean,
    ) as LegacyFrame[];
    return {
      frames: loaded
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((f) => ({
          ...f,
          data: f.data?.startsWith('data:') ? f.data : 'data:image/webp;base64,' + f.data,
          sceneCut: !!f.sceneCut,
        })),
      available: available.length,
      range: [start, end],
      gaps: loaded.length
        ? ['仅代表已缓存的抽样画面；缓存间隔、跳转、淘汰或跨域限制可能造成缺口。']
        : ['此范围没有缓存画面，可调用analyze_video后台补帧。'],
      coverage: { first: available[0]?.timestamp ?? null, last: available.at(-1)?.timestamp ?? null },
    };
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.cache.close();
    for (const pending of this.runtimes.values()) {
      const runtime = await pending;
      await runtime.index.persist();
      await Promise.all([...runtime.archive.queues.values()]);
    }
  }
}
