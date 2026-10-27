import fs from 'node:fs/promises';
import path from 'node:path';
import type { MediaAnalysis, EvidenceFrame } from '../shared/contracts';
import { atomicJson, readJson } from './storage';

export class MediaStore {
  constructor(private readonly root: string) {}
  async save(result: MediaAnalysis): Promise<void> {
    const directory = path.join(this.root, result.sourceId, result.id);
    await fs.mkdir(directory, { recursive: true });
    for (let i = 0; i < result.frames.length; i++) {
      const data = result.frames[i].data;
      if (!data?.startsWith('data:image/webp;base64,')) throw new Error('解析画面格式错误。');
      await fs.writeFile(path.join(directory, i + '.webp'), Buffer.from(data.split(',')[1], 'base64'));
    }
    await atomicJson(path.join(this.root, result.sourceId, 'latest.json'), {
      ...result,
      frames: result.frames.map((frame) => ({ ...frame, data: null })),
    });
    await atomicJson(path.join(this.root, 'last.json'), { sourceId: result.sourceId });
  }
  async last(): Promise<MediaAnalysis | null> {
    const pointer = await readJson<{ sourceId: string } | null>(path.join(this.root, 'last.json'), null);
    if (!pointer || !/^[a-zA-Z0-9-]{1,80}$/.test(pointer.sourceId)) return null;
    const result = await readJson<MediaAnalysis | null>(
      path.join(this.root, pointer.sourceId, 'latest.json'),
      null,
    );
    if (!result || !/^[a-zA-Z0-9-]{1,80}$/.test(result.id) || result.frames.length > 12) return null;
    const frames = await Promise.all(
      result.frames.map(async (frame, index) => ({
        ...frame,
        data:
          'data:image/webp;base64,' +
          (await fs.readFile(path.join(this.root, pointer.sourceId, result.id, index + '.webp'))).toString(
            'base64',
          ),
      })),
    );
    return { ...result, frames };
  }
  async nearby(sourceId: string, time: number, cutoff: string): Promise<EvidenceFrame[]> {
    const result = await readJson<MediaAnalysis | null>(path.join(this.root, sourceId, 'latest.json'), null);
    if (!result || result.createdAt > cutoff) return [];
    const directory = path.join(this.root, sourceId, result.id);
    return Promise.all(
      result.frames
        .map((frame, index) => ({ frame, index }))
        .filter(({ frame }) => frame.timestamp <= time && frame.timestamp >= time - 90)
        .slice(-6)
        .map(async ({ frame, index }) => ({
          ...frame,
          data:
            'data:image/webp;base64,' +
            (await fs.readFile(path.join(directory, index + '.webp'))).toString('base64'),
        })),
    );
  }
}
