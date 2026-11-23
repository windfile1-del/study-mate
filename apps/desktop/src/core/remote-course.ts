import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError } from './errors';
import type { LearningSource } from '../shared/contracts';
import { referrerHeaders } from './http-referrer';

export interface RemotePlayback {
  kind: 'progressive' | 'separate';
  sourceId: string;
  duration: number;
  tracks: { path: string; mime: string; kind: 'video' | 'audio'; cacheKey?: string }[];
}
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Track = { sourceId: string; url: string; referer: string; expires: number };
export function courseCdn(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    (!u.port || u.port === '443') &&
    ['bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'akamaized.net'].some(
      (host) => u.hostname === host || u.hostname.endsWith('.' + host),
    )
  );
}

/** The phone receives opaque LAN paths. CDN URLs and the desktop browser session stay here. */
export class RemoteCourseMedia {
  private tracks = new Map<string, Track>();
  constructor(
    private fetch: Fetch,
    private source: (id: string) => LearningSource,
    private now = Date.now,
  ) {}
  async prepare(sourceId: string): Promise<RemotePlayback> {
    const source = this.source(sourceId);
    if (source.kind === 'local-video')
      return {
        kind: 'progressive',
        sourceId,
        duration: 0,
        tracks: [
          {
            path: '/v1/media/' + sourceId,
            mime: /\.webm$/i.test(source.localPath || '')
              ? 'video/webm'
              : /\.mkv$/i.test(source.localPath || '')
                ? 'video/x-matroska'
                : 'video/mp4',
            kind: 'video',
          },
        ],
      };
    if (source.kind !== 'bilibili' || !source.platformVideoId)
      throw new AppError('MEDIA_UNSUPPORTED', '此来源暂不支持原生课程播放。');
    const json = async (url: string) => {
      const response = await this.fetch(url, {
        headers: referrerHeaders(source.url, url),
        signal: AbortSignal.timeout(20000),
      }).catch(() => {
        throw new AppError(
          'BILI_NETWORK',
          '课程请求被网络或站点拒绝，请先在电脑确认课程可正常播放，再重试。',
        );
      });
      if (!response.ok)
        throw new AppError(
          'BILI_NETWORK',
          `课程接口暂不可用（HTTP ${response.status}），请在电脑确认可正常播放。`,
        );
      const value = await response.json().catch(() => {
        throw new AppError('BILI_NETWORK', '课程站点未返回可读取的视频信息，请在电脑检查访问状态。');
      });
      if (value.code !== 0 || !value.data || typeof value.data !== 'object')
        throw new AppError('BILI_ACCESS', '课程未提供播放权限，请在电脑课程页确认访问权限。');
      return value.data;
    };
    const info = await json(
      'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(source.platformVideoId),
    );
    const part = info.pages?.find((p: { page: number }) => p.page === (source.partIndex || 1));
    if (!Number.isSafeInteger(part?.cid) || part.cid <= 0)
      throw new AppError('BILI_PART', '当前分P没有可播放内容。');
    const play = await json(
      'https://api.bilibili.com/x/player/playurl?bvid=' +
        encodeURIComponent(source.platformVideoId) +
        '&cid=' +
        part.cid +
        '&qn=80&fnval=4048&fourk=0',
    );
    const video = (play.dash?.video || [])
      .filter((v: any) => v.codecid === 7)
      .sort((a: any, b: any) => (b.height || 0) - (a.height || 0))[0];
    const audio = (play.dash?.audio || [])
      .filter((a: any) => a.codecs?.startsWith('mp4a'))
      .sort((a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const selected: { url: string; mime: string; kind: 'video' | 'audio' }[] =
      video && audio
        ? [
            { url: video.baseUrl || video.base_url, mime: 'video/mp4', kind: 'video' },
            { url: audio.baseUrl || audio.base_url, mime: 'audio/mp4', kind: 'audio' },
          ]
        : play.durl?.length === 1
          ? [{ url: play.durl[0].url, mime: 'video/mp4', kind: 'video' }]
          : [];
    if (!selected.length || selected.some((t) => !t.url || !courseCdn(t.url)))
      throw new AppError('MEDIA_UNSUPPORTED', '没有受支持的 H.264/AAC 课程流。');
    for (const [id, track] of this.tracks) if (track.expires <= this.now()) this.tracks.delete(id);
    while (this.tracks.size + selected.length > 64) this.tracks.delete(this.tracks.keys().next().value!);
    return {
      kind: selected.length === 2 ? 'separate' : 'progressive',
      sourceId,
      duration: Number(play.dash?.duration || play.timelength / 1000 || part.duration || 0),
      tracks: selected.map((t) => {
        const id = randomUUID();
        this.tracks.set(id, { sourceId, url: t.url, referer: source.url, expires: this.now() + 10 * 60000 });
        const cacheKey = createHash('sha256').update(new URL(t.url).pathname + ':' + t.kind + ':' + t.mime).digest('hex');
        return { path: `/v1/media/${sourceId}/tracks/${id}`, kind: t.kind, mime: t.mime, cacheKey };
      }),
    };
  }
  async read(
    sourceId: string,
    trackId: string,
    range: string | undefined,
    head: boolean,
    signal: AbortSignal,
  ) {
    this.source(sourceId);
    const track = this.tracks.get(trackId);
    if (!track || track.sourceId !== sourceId || track.expires <= this.now())
      throw new AppError('NOT_FOUND', '课程播放连接已过期，请重新打开。');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      throw new AppError('INVALID_INPUT', '仅支持单段媒体范围。');
    let url = track.url;
    for (let redirects = 0; redirects < 5; redirects++) {
      if (!courseCdn(url)) throw new AppError('PERMISSION_DENIED', '课程流跳转到未授权地址。');
      const response = await this.fetch(url, {
        method: head ? 'HEAD' : 'GET',
        headers: referrerHeaders(track.referer, url, range ? { Range: range } : {}),
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) break;
        url = new URL(location, url).href;
        continue;
      }
      if (![200, 206, 416].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError('BILI_NETWORK', `课程媒体暂不可用（HTTP ${response.status}）。`);
      }
      const headers: Record<string, string> = {};
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = response.headers.get(key);
        if (value) headers[key] = value;
      }
      if (head) await response.body?.cancel();
      return {
        status: response.status,
        headers,
        body: head || !response.body ? null : Readable.fromWeb(response.body as any),
      };
    }
    throw new AppError('BILI_NETWORK', '课程媒体跳转次数过多。');
  }
  clear() {
    this.tracks.clear();
  }
}
