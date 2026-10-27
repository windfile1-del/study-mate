import { protocol, session, type Session } from 'electron';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors';

export const LOCAL_PARTITION = 'study-mate-local-player';
export const DECODER_PARTITION = 'study-mate-native-decoder';
protocol.registerSchemesAsPrivileged([
  {scheme:'study-model',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}},
  {
    scheme: 'study-document',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  { scheme: 'study-note', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'study-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

type Asset = { file: string } | { url: string; referer: string; allowed: (url: URL) => boolean };
const types: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.avi': 'video/x-msvideo',
};
export class MediaGateway {
  private assets = new Map<string, Asset>();
  initialize(): void {
    for (const partition of [LOCAL_PARTITION, DECODER_PARTITION]) {
      const ses = session.fromPartition(partition);
      ses.setPermissionRequestHandler((_w, _p, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.protocol.handle('study-media', (request) => this.handle(request));
    }
  }
  local(file: string): string {
    return this.add({ file });
  }
  remote(url: string, referer: string, allowed: (url: URL) => boolean): string {
    if (!allowed(new URL(url))) throw new AppError('MEDIA_HOST', '视频地址不属于当前来源。');
    return this.add({ url, referer, allowed });
  }
  private add(asset: Asset): string {
    const id = randomUUID();
    this.assets.set(id, asset);
    return 'study-media://asset/' + id;
  }
  revoke(url: string): void {
    this.assets.delete(new URL(url).pathname.slice(1));
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const asset = url.hostname === 'asset' ? this.assets.get(url.pathname.slice(1)) : undefined;
      if (!asset) return new Response('资源已关闭', { status: 404 });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if ('file' in asset) {
        const stat = await fs.stat(asset.file);
        if (!stat.isFile()) return new Response(null, { status: 404 });
        const range = request.headers.get('range');
        let start = 0,
          end = stat.size - 1,
          partial = false;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2]))
            return new Response(null, {
              status: 416,
              headers: { ...cors, 'Content-Range': 'bytes */' + stat.size },
            });
          start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= stat.size
          ) {
            return new Response(null, {
              status: 416,
              headers: { ...cors, 'Content-Range': 'bytes */' + stat.size },
            });
          }
          partial = true;
        }
        const headers = {
          ...cors,
          'Content-Type': types[path.extname(asset.file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': String(Math.max(0, end - start + 1)),
          ...(partial ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size } : {}),
        };
        const body =
          request.method === 'HEAD' || !stat.size
            ? null
            : (Readable.toWeb(createReadStream(asset.file, { start, end })) as ReadableStream);
        return new Response(body, { status: partial ? 206 : 200, headers });
      }
      let target = asset.url;
      const browserSession: Session = session.fromPartition('persist:study-mate-browser');
      for (let redirects = 0; redirects < 5; redirects++) {
        if (!asset.allowed(new URL(target))) throw new AppError('MEDIA_HOST', '视频重定向到了未授权地址。');
        const headers: Record<string, string> = { Referer: asset.referer };
        if (request.headers.get('range')) headers.Range = request.headers.get('range')!;
        const response = await browserSession.fetch(target, {
          method: request.method,
          headers,
          redirect: 'manual',
          signal: request.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) break;
          target = new URL(location, target).href;
          continue;
        }
        const output = new Headers(cors);
        for (const key of ['content-type', 'content-length', 'content-range']) {
          const value = response.headers.get(key);
          if (value) output.set(key, value);
        }
        return new Response(response.body, { status: response.status, headers: output });
      }
      throw new Error('重定向次数过多');
    } catch {
      return new Response('视频资源不可用，请重新打开课程后重试。', { status: 502 });
    }
  }
}
