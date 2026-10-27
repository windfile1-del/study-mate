import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, SerialQueue } from './storage';
import type { TranscriptSegment, OcrResult } from '../shared/recognition';
export class RecognitionStore {
  private writes = new SerialQueue();
  constructor(readonly root: string) {}
  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
  }
  async transcript(id: string, start = 0, end = 1e9) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw Error('课程编号无效');
    const rows = await readJson<TranscriptSegment[]>(path.join(this.root, id + '.json'), []);
    return rows.filter((r) => r.end >= start && r.start <= end);
  }
  append(rows: TranscriptSegment[]) {
    if (!rows.length) return Promise.resolve();
    return this.writes.run(async () => {
      const source = rows[0].sourceId,
        existing = await this.transcript(source);
      const next = [...existing, ...rows].sort(
        (a, b) => a.start - b.start || a.createdAt.localeCompare(b.createdAt),
      );
      await atomicJson(path.join(this.root, source + '.json'), next);
    });
  }
  saveOcr(row: OcrResult) {
    return this.writes.run(() => atomicJson(path.join(this.root, row.id + '.json'), row));
  }
  close() {
    return this.writes.flush();
  }
}
