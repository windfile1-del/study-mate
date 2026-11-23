import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';

/** A single byte range with correct HEAD, empty-file and unsatisfiable responses. */
export async function localFileResponse(file: string, range: string | undefined, head = false) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw Error('媒体文件不存在。');
  const mime: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
  };
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  let start = 0,
    end = stat.size - 1,
    status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]) || !stat.size)
      return { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + stat.size }, body: null };
    start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size)
      return { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + stat.size }, body: null };
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  return { status, headers, body: head || !stat.size ? null : createReadStream(file, { start, end }) };
}
