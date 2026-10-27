import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as CFB from 'cfb';
import { atomicJson, readJson, SerialQueue, requireDDrive } from './storage';
import { EventEmitter } from 'node:events';
import type { DocumentInfo } from '../shared/documents';
export function inspectPresentationZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error('PowerPoint 压缩包无效。');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true),
    total = 0;
  if (count > 10000) throw Error('PowerPoint 包含过多资源。');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
      throw Error('PowerPoint 目录损坏。');
    const size = view.getUint32(offset + 24, true);
    total += size;
    if (size > 40 * 1024 * 1024 || total > 160 * 1024 * 1024)
      throw Error('PowerPoint 解压资源超过安全预算。');
    const length = view.getUint16(offset + 28, true),
      name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length));
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw Error('PowerPoint 内部路径无效。');
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}
export function extractLegacyPpt(bytes: Buffer): string[] {
  const file = CFB.read(bytes, { type: 'buffer' }),
    stream = CFB.find(file, 'PowerPoint Document');
  if (!stream?.content) throw Error('旧版 PPT 不包含可读取的幻灯片流，可能已加密或损坏。');
  const data = Buffer.from(stream.content as Uint8Array),
    groups: string[][] = [];
  let visited = 0;
  const walk = (start: number, end: number, depth: number) => {
    if (depth > 32) throw Error('旧版 PPT 嵌套过深。');
    for (let at = start; at + 8 <= end;) {
      if (++visited > 200000) throw Error('旧版 PPT 记录过多。');
      const header = data.readUInt16LE(at),
        type = data.readUInt16LE(at + 2),
        length = data.readUInt32LE(at + 4),
        to = at + 8 + length;
      if (to > end) break;
      if (type === 4080 && header >> 4 === 0) {
        const slides: string[][] = [];
        let current: string[] = [],
          begun = false;
        for (let p = at + 8; p + 8 <= to;) {
          const kind = data.readUInt16LE(p + 2),
            size = data.readUInt32LE(p + 4),
            next = p + 8 + size;
          if (next > to) break;
          if (kind === 1011) {
            if (begun) slides.push(current);
            current = [];
            begun = true;
          }
          if (kind === 4000) current.push(data.subarray(p + 8, next).toString('utf16le'));
          if (kind === 4008) current.push(new TextDecoder('windows-1252').decode(data.subarray(p + 8, next)));
          p = next;
        }
        if (begun || current.length) slides.push(current);
        if (slides.length) groups.push(slides.map((s) => s.join('\n')));
      } else if ((header & 15) === 15) walk(at + 8, to, depth + 1);
      at = to;
    }
  };
  walk(0, data.length, 0);
  const result = groups.at(-1);
  if (!result?.length) throw Error('此旧版 PPT 未能提取幻灯片文字；请使用 PPTX 或 PDF。');
  return result
    .map((s) =>
      s
        .replace(/[\x00-\x08\x0b\x0c]/g, '')
        .replace(/\r/g, '\n')
        .slice(0, 200000),
    )
    .slice(0, 2000);
}
export class DocumentRegistry extends EventEmitter {
  private entries: DocumentInfo[] = [];
  private queue = new SerialQueue();
  constructor(readonly root: string) {
    super();
    requireDDrive(root);
  }
  async initialize() {
    await fs.mkdir(path.join(this.root, 'files'), { recursive: true });
    const entries = await readJson<DocumentInfo[]>(path.join(this.root, 'library.json'), []);
    this.entries = entries.filter(
      (d) =>
        /^doc-[a-f0-9]{24}$/.test(d.id) &&
        /^[a-f0-9]{64}$/.test(d.revision) &&
        ['pdf', 'pptx', 'ppt'].includes(d.kind),
    );
  }
  list() {
    return this.entries.map((d) => structuredClone(d)).reverse();
  }
  get(id: string) {
    const d = this.entries.find((d) => d.id === id);
    if (!d) throw Error('文档未注册，请先通过“打开文档”选择文件。');
    return structuredClone(d);
  }
  file(id: string) {
    const d = this.get(id);
    return path.join(this.root, 'files', d.revision + '.' + d.kind);
  }
  async register(file: string): Promise<DocumentInfo> {
    const actual = await fs.realpath(file),
      extension = path.extname(actual).toLowerCase(),
      kind =
        extension === '.pdf' ? 'pdf' : extension === '.pptx' ? 'pptx' : extension === '.ppt' ? 'ppt' : null;
    if (!kind) throw Error('请选择 PDF、PPTX 或旧版 PPT 文件。');
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024 || (kind === 'ppt' && stat.size > 32 * 1024 * 1024))
      throw Error('文档过大：PDF/PPTX 最多128MiB，旧版PPT最多32MiB。');
    const bytes = await fs.readFile(actual);
    if (bytes.length > 128 * 1024 * 1024) throw Error('文档超过大小上限。');
    if (kind === 'pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw Error('文件不包含有效 PDF 标识。');
    if (kind === 'pptx') inspectPresentationZip(bytes);
    const legacy = kind === 'ppt' ? extractLegacyPpt(bytes) : null;
    const revision = createHash('sha256').update(bytes).digest('hex'),
      id = 'doc-' + revision.slice(0, 24);
    const existing = this.entries.find((d) => d.id === id);
    if (existing) return this.get(id);
    const item: DocumentInfo = {
      id,
      revision,
      title: path.basename(actual),
      kind,
      pages: legacy?.length || 0,
      outline:
        legacy?.map((s, i) => ({
          title: s.split('\n')[0].slice(0, 90) || '幻灯片 ' + (i + 1),
          page: i + 1,
          depth: 0,
        })) || [],
      locked: false,
      warning:
        kind === 'ppt' ? '旧版 PPT 为简化文字阅读，原始版式/图片/动画不保真；建议使用 PPTX 或 PDF。' : '',
      lastPage: 1,
      size: bytes.length,
      createdAt: new Date().toISOString(),
    };
    await fs
      .writeFile(path.join(this.root, 'files', revision + '.' + kind), bytes, { flag: 'wx' })
      .catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    if (legacy) await atomicJson(path.join(this.root, 'files', revision + '.json'), legacy);
    this.entries.push(item);
    await this.persist();
    this.emit('changed');
    return this.get(id);
  }
  async update(
    id: string,
    patch: Partial<Pick<DocumentInfo, 'pages' | 'outline' | 'locked' | 'warning' | 'lastPage'>>,
  ) {
    const d = this.entries.find((d) => d.id === id);
    if (!d) throw Error('文档不存在。');
    Object.assign(d, patch);
    await this.persist();
    this.emit('changed');
    return this.get(id);
  }
  async legacy(id: string) {
    const d = this.get(id);
    if (d.kind !== 'ppt') throw Error('不是旧版 PPT。');
    return readJson<string[]>(path.join(this.root, 'files', d.revision + '.json'), []);
  }
  private persist() {
    return this.queue.run(() => atomicJson(path.join(this.root, 'library.json'), this.entries));
  }
  close() {
    return this.queue.flush();
  }
}
