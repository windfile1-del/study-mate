import fs from 'node:fs/promises';
import path from 'node:path';
import type { Session } from 'electron';
import type { LearningSource, LearningContext } from '../shared/contracts';
import { parseSrt } from '../../../../vendor/video-observer/src/subtitle/SubtitleTimeline.mjs';
export async function localSubtitles(file: string): Promise<LearningContext['subtitles']> {
  const stem = file.slice(0, file.length - path.extname(file).length);
  for (const suffix of ['.srt', '.vtt', '.zh-CN.srt', '.zh.srt', '.zh-CN.vtt', '.zh.vtt']) {
    try {
      const candidate = stem + suffix,
        actual = await fs.realpath(candidate);
      if (path.dirname(actual).toLowerCase() !== path.dirname(file).toLowerCase()) continue;
      const stat = await fs.stat(actual);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const bytes = await fs.readFile(actual),
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return parseSrt(text, 'local-' + path.extname(actual).slice(1))
        .filter((r: any) => r.to >= r.from)
        .slice(0, 20000);
    } catch {}
  }
  return [];
}
export async function biliSubtitles(
  source: LearningSource,
  ses: Session,
): Promise<LearningContext['subtitles']> {
  const read = async (url: string) => {
    const response = await ses.fetch(url, {
      headers: { Referer: source.url },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('字幕请求不可用');
    const reader = response.body?.getReader();
    if (!reader) throw Error('字幕响应为空');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const row = await reader.read();
        if (row.done) break;
        size += row.value.byteLength;
        if (size > 2 * 1024 * 1024) throw Error('字幕文件超过读取上限');
        chunks.push(row.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const info = await read(
    'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(source.platformVideoId!),
  );
  if (info.code !== 0) return [];
  const cid = info.data?.pages?.find((p: any) => p.page === (source.partIndex || 1))?.cid;
  if (!cid) return [];
  const player = await read(
    'https://api.bilibili.com/x/player/wbi/v2?bvid=' +
      encodeURIComponent(source.platformVideoId!) +
      '&cid=' +
      encodeURIComponent(cid),
  );
  if (player.code !== 0) return [];
  const tracks = player.data?.subtitle?.subtitles || [],
    track = tracks.find((t: any) => /^zh/.test(t.lan)) || tracks[0];
  if (!track?.subtitle_url) return [];
  const url = new URL(track.subtitle_url, 'https://www.bilibili.com');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !['bilibili.com', 'hdslb.com'].some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
  )
    return [];
  const body = await read(url.href);
  return (Array.isArray(body.body) ? body.body : [])
    .slice(0, 20000)
    .filter((r: any) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.from >= 0 && r.to >= r.from)
    .map((r: any) => ({
      from: r.from,
      to: r.to,
      text: String(r.content || '').slice(0, 5000),
      source: 'bilibili-' + String(track.lan || 'unknown'),
    }));
}
