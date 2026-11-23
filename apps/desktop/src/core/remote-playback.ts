import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, SerialQueue } from './storage';
import { AppError } from './errors';
import type { PlaybackCheckpoint, PlaybackOffer, PlaybackProgress, RemoteDevice } from '../shared/remote';

type RecordRow = PlaybackCheckpoint & { deviceId: string; vaultId: string };
/** Tablet progress is separate from desktop observation. Only an explicit desktop click consumes an offer. */
export class RemotePlaybackStore {
  private rows: RecordRow[] = [];
  private offers: PlaybackOffer[] = [];
  private consumed: string[] = [];
  private sessions = new Map<string, { id: string; sequence: number; offerSequence: number }>();
  private queue = new SerialQueue();
  private file: string;
  constructor(root: string) { this.file = path.join(root, 'playback.json'); }
  async initialize() {
    const saved = await readJson<{ rows: RecordRow[]; offers: PlaybackOffer[]; consumed?: string[] }>(this.file, { rows: [], offers: [] });
    this.rows = saved.rows; this.offers = saved.offers; this.consumed = saved.consumed || [];
  }
  private key(d: RemoteDevice, sourceId: string) { return `${d.vaultId}:${d.id}:${sourceId}`; }
  checkpoint(d: RemoteDevice, sourceId: string): PlaybackCheckpoint | null {
    const row = this.rows.find((r) => r.deviceId === d.id && r.vaultId === d.vaultId && r.sourceId === sourceId);
    if (!row) return null;
    const { deviceId, vaultId, ...safe } = row;
    return { ...safe };
  }
  start(d: RemoteDevice, sourceId: string) {
    return this.queue.run(async () => {
      const sessionId = randomUUID();
      this.sessions.delete(this.key(d, sourceId));
      this.sessions.set(this.key(d, sourceId), { id: sessionId, sequence: -1, offerSequence: -1 });
      while (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value!);
      return { sessionId, checkpoint: this.checkpoint(d, sourceId) };
    });
  }
  save(d: RemoteDevice, p: PlaybackProgress) {
    return this.queue.run(async () => {
      const session = this.sessions.get(this.key(d, p.sourceId));
      if (!session || session.id !== p.sessionId) throw new AppError('STALE_CONTEXT', '播放器已重新打开，请重新连接课程。');
      if (p.sequence <= session.sequence) return this.checkpoint(d, p.sourceId);
      const row: RecordRow = { deviceId: d.id, vaultId: d.vaultId, sourceId: p.sourceId, position: Math.min(p.position, p.duration), duration: p.duration, rate: p.rate, updatedAt: new Date().toISOString() };
      const rows = [...this.rows.filter((r) => !(r.deviceId === d.id && r.vaultId === d.vaultId && r.sourceId === p.sourceId)), row].slice(-2000);
      await atomicJson(this.file, { rows, offers: this.offers, consumed: this.consumed });
      this.rows = rows; session.sequence = p.sequence;
      return this.checkpoint(d, p.sourceId);
    });
  }
  async offer(d: RemoteDevice, p: PlaybackProgress & { requestId: string }, title: string) {
    await this.save(d, p);
    return this.queue.run(async () => {
      if (this.consumed.includes(p.requestId)) throw new AppError('STALE_CONTEXT', '这条接力请求已处理，请重新点击发送接力。');
      const existing = this.offers.find((r) => r.id === p.requestId);
      if (existing) {
        if (existing.deviceId !== d.id || existing.vaultId !== d.vaultId || existing.sourceId !== p.sourceId || existing.position !== p.position || existing.duration !== p.duration || existing.rate !== p.rate)
          throw new AppError('STALE_CONTEXT', '接力请求编号已经使用。');
        return { ...existing };
      }
      const session = this.sessions.get(this.key(d, p.sourceId));
      if (!session || session.id !== p.sessionId || p.sequence <= session.offerSequence)
        throw new AppError('STALE_CONTEXT', '已有更新的播放接力请求。');
      // Use this button click's frozen position, never a later periodic progress update.
      const offer: PlaybackOffer = { id: p.requestId, deviceId: d.id, deviceName: d.name, vaultId: d.vaultId, sourceId: p.sourceId, title, position: p.position, duration: p.duration, rate: p.rate, updatedAt: new Date().toISOString() };
      const offers = [...this.offers.filter((r) => r.deviceId !== d.id || r.vaultId !== d.vaultId), offer].slice(-100);
      const consumed = [...this.consumed, ...this.offers.filter((r) => r.deviceId === d.id && r.vaultId === d.vaultId).map((r) => r.id)].slice(-2000);
      await atomicJson(this.file, { rows: this.rows, offers, consumed }); this.offers = offers; this.consumed = consumed; session.offerSequence = p.sequence;
      return { ...offer };
    });
  }
  pending(vaultId: string, devices: RemoteDevice[]) {
    return this.offers.filter((r) => r.vaultId === vaultId && devices.some((d) => d.id === r.deviceId && !d.revoked && d.vaultId === vaultId)).map((r) => ({ ...r }));
  }
  async dismiss(id: string) {
    await this.queue.run(async () => {
      const offers = this.offers.filter((r) => r.id !== id);
      const consumed = [...this.consumed, id].slice(-2000);
      await atomicJson(this.file, { rows: this.rows, offers, consumed }); this.offers = offers; this.consumed = consumed;
    });
  }
}
