import { BrowserWindow, session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AnalysisInput, LearningSource, MediaAnalysis, ObservationBinding } from '../shared/contracts';
import type { AppKernel } from './kernel';
import { AppError } from '../core/errors';
import { SerialQueue } from '../core/storage';
import { MediaGateway, DECODER_PARTITION } from './media-gateway';
import { decodeOnlinePage } from './page-video-decoder';

const biliHost = (url: URL) =>
  url.protocol === 'https:' &&
  !url.username &&
  !url.password &&
  ['bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'akamaized.net'].some(
    (host) => url.hostname === host || url.hostname.endsWith('.' + host),
  );
export class MediaController {
  private queue = new SerialQueue();
  constructor(
    private readonly kernel: AppKernel,
    private readonly gateway: MediaGateway,
    private readonly decoderUrl: string,
  ) {}
  submit(input: AnalysisInput, contents: WebContents | undefined): string {
    return this.start(input, contents).id;
  }
  async analyzeForAssistant(
    input: AnalysisInput,
    contents: WebContents | undefined,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<MediaAnalysis> {
    signal.throwIfAborted();
    const source = this.kernel.sources.get(sourceId);
    const task = this.start(input, contents, source);
    const cancel = () => this.kernel.tasks.cancel(task.id);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      return await task.done;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  private start(input: AnalysisInput, contents: WebContents | undefined, selected?: LearningSource) {
    const binding = this.kernel.sources.active;
    if (!binding && !selected) throw new AppError('NO_MEDIA', '请先打开本地视频或课程。');
    const source = selected || this.kernel.sources.get(binding!.sourceId);
    if (input.end !== null && input.end <= input.start)
      throw new AppError('MEDIA_RANGE', '解析终点需大于起点。');
    // Freeze the page and source at submission, before the queued task can run.
    const page =
      source.kind === 'web' && binding?.sourceId === source.id
        ? this.pageMedia(contents, binding!)
        : Promise.resolve(null);
    void page.catch(() => {});
    const task = this.kernel.tasks.submit(
      '原生视频解析 · ' + source.title,
      (signal) =>
        this.queue.run(async () => {
          signal.throwIfAborted();
          const snapshot = await page;
          signal.throwIfAborted();
          let asset: string | undefined;
          try {
            let decoded: Pick<MediaAnalysis, 'duration' | 'width' | 'height' | 'frames'>;
            try {
              asset = await this.resolve(source, snapshot, signal);
              decoded = await this.decode(asset, input, signal);
            } catch (e) {
              signal.throwIfAborted();
              if (source.kind !== 'web'&&source.kind!=='bilibili') throw e;
              decoded = await decodeOnlinePage(
                source.url,
                input,
                session.fromPartition('persist:study-mate-browser'),
                signal,
              );
            }
            signal.throwIfAborted();
            const result: MediaAnalysis = {
              ...decoded,
              id: randomUUID(),
              sourceId: source.id,
              title: source.title,
              createdAt: new Date().toISOString(),
            };
            result.frames = result.frames.map((frame, i) => ({ ...frame, id: result.id + '-' + i }));
            await this.kernel.mediaStore.save(result);
            signal.throwIfAborted();
            this.kernel.analysis = result;
            this.kernel.emit('changed');
            return result;
          } finally {
            if (asset) this.gateway.revoke(asset);
          }
        }),
      source.id,
    );
    void task.done.catch(() => this.kernel.emit('changed'));
    return task;
  }
  private async pageMedia(
    contents: WebContents | undefined,
    binding: ObservationBinding,
  ): Promise<{ src: string } | null> {
    if (!contents || contents.isDestroyed()) return null;
    const result = await contents.executeJavaScript(
      '(() => { const v = [...document.querySelectorAll("video")].sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0]; return {src:v?.currentSrc || ""}; })()',
    );
    if (this.kernel.sources.active?.visitId !== binding.visitId)
      throw new AppError('STALE_SOURCE', '提交解析时课程发生了切换，请重试。');
    return result;
  }
  private async resolve(
    source: LearningSource,
    page: { src: string } | null,
    signal: AbortSignal,
  ): Promise<string> {
    if (source.kind === 'local-video' && source.localPath) {
      const stat = await fs.stat(source.localPath);
      if (!source.canonicalKey.endsWith(':' + stat.size + ':' + stat.mtimeMs))
        throw new AppError('MEDIA_CHANGED', '视频文件已发生变化，请重新打开后解析。');
      return this.gateway.local(source.localPath);
    }
    if (source.kind === 'bilibili') {
      const ses = session.fromPartition('persist:study-mate-browser');
      const json = async (url: string) => {
        const timeout = AbortSignal.timeout(20000);
        const response = await ses
          .fetch(url, {
            headers: { Referer: source.url },
            signal: AbortSignal.any([signal, timeout]),
          })
          .catch((error) => {
            signal.throwIfAborted();
            throw new AppError(
              'BILI_NETWORK',
              'B站视频信息请求失败，请检查网络、站点访问限制或在课程页完成登录后重试。' +
                (error instanceof Error ? '（' + error.message + '）' : ''),
            );
          });
        if (!response.ok) throw new AppError('BILI_NETWORK', 'B站接口暂时不可用，请稍后重试。');
        const result = await response.json();
        if (result.code !== 0)
          throw new AppError(
            'BILI_ACCESS',
            'B站未提供可解析视频：' +
              String(result.message || result.code) +
              '。可先在课程页登录或继续使用已观察的上下文。',
          );
        return result.data;
      };
      const info = await json(
        'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(source.platformVideoId!),
      );
      const part = info.pages?.find((item: { page: number }) => item.page === (source.partIndex || 1));
      if (!part?.cid) throw new AppError('BILI_PART', '未找到当前分P对应的视频。');
      // Do not substitute the part number for the platform cid.
      const play = await json(
        'https://api.bilibili.com/x/player/playurl?bvid=' +
          encodeURIComponent(source.platformVideoId!) +
          '&cid=' +
          part.cid +
          '&qn=80&fnval=4048&fourk=0',
      );
      const payload = play as {
        dash?: {
          video?: Array<{
            baseUrl?: string;
            base_url?: string;
            codecid?: number;
            width?: number;
            height?: number;
          }>;
        };
        durl?: Array<{ url: string }>;
      };
      const candidates = (payload?.dash?.video || [])
        .filter((item) => item.codecid === 7)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      const media =
        candidates[0]?.baseUrl ||
        candidates[0]?.base_url ||
        (payload?.durl?.length === 1 ? payload.durl[0].url : '');
      if (!media)
        throw new AppError(
          'MEDIA_UNSUPPORTED',
          '当前课程没有可用的原生解码流，可能需要登录、受权限限制或使用了不支持的编码。可继续读取已观察的上下文。',
        );
      return this.gateway.remote(media, source.url, biliHost);
    }
    if (page?.src && /^https?:\/\//.test(page.src)) {
      const origin = new URL(source.url).origin;
      return this.gateway.remote(
        page.src,
        source.url,
        (url) =>
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.origin === origin,
      );
    }
    throw new AppError(
      'MEDIA_UNSUPPORTED',
      '此网页使用不可独立访问的实时流或 Blob 视频。可读取已观察的上下文，或打开本地视频进行解析。',
    );
  }
  private async decode(
    url: string,
    input: AnalysisInput,
    signal: AbortSignal,
  ): Promise<Pick<MediaAnalysis, 'duration' | 'width' | 'height' | 'frames'>> {
    signal.throwIfAborted();
    const worker = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        partition: DECODER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
        webSecurity: true,
      },
    });
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    worker.webContents.on('will-navigate', (event) => event.preventDefault());
    const close = () => {
      if (!worker.isDestroyed()) worker.destroy();
    };
    const timeout = setTimeout(close, 180000);
    signal.addEventListener('abort', close, { once: true });
    try {
      await worker.loadURL(this.decoderUrl);
      signal.throwIfAborted();
      return await worker.webContents.executeJavaScript(
        'window.studyMateDecodeJob(' + JSON.stringify({ ...input, url }) + ')',
      );
    } catch (error) {
      signal.throwIfAborted();
      throw new AppError('MEDIA_DECODE', error instanceof Error ? error.message : '视频解析失败，请重试。');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', close);
      close();
    }
  }
}
