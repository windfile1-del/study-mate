import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, SerialQueue } from './storage';
import { annotationRequest, type AnnotationPage } from '../shared/annotations';
import type { DocumentInfo } from '../shared/documents';
export class AnnotationStore {
  private queue = new SerialQueue();
  constructor(private root: string) {}
  async request(raw: unknown, document: DocumentInfo): Promise<AnnotationPage> {
    const input = annotationRequest.parse(raw);
    if (
      input.id !== document.id ||
      input.revision !== document.revision ||
      input.page > document.pages ||
      document.locked
    )
      throw Error('文档来源或页码已失效，请重新打开后批注');
    return this.queue.run(async () => {
      const file = path.join(this.root, input.id, input.page + '.json'),
        existing = await readJson<AnnotationPage>(file, {
          version: 0,
          revision: input.revision,
          strokes: [],
          updatedAt: null,
        });
      if (input.action === 'get') return existing;
      if (input.version !== existing.version)
        throw Error('此页批注已在另一视图更新，已保留本地草稿，请重新打开本页核对。');
      if (input.strokes.reduce((n, s) => n + s.points.length, 0) > 40000)
        throw Error('本页笔迹过多，请分段保存或清理部分笔迹');
      const next = {
        version: existing.version + 1,
        revision: input.revision,
        strokes: input.strokes,
        updatedAt: new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicJson(file, next);
      return next;
    });
  }
  close() {
    return this.queue.flush();
  }
}
