import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, SerialQueue } from './storage';
import {
  defaultVideoCache,
  videoCacheSettings,
  type VideoCacheSettings,
  type VideoCacheState,
} from '../shared/video-cache';
export class VideoCacheManager {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextExpiry:number|undefined;
  private closed=false;
  private writes = new SerialQueue();
  readonly state: VideoCacheState = {
    settings: { ...defaultVideoCache },
    lastCleanup: null,
    nextCleanup: null,
    removed: 0,
    bytesFreed: 0,
    cachedBytes: 0,
    cachedFrames: 0,
    cleaning: false,
    error: '',
  };
  constructor(
    readonly root: string,
    private onRemoved: (files: Set<string>) => void = () => {},
  ) {}
  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    const saved = await readJson(path.join(this.root, 'video-cache-settings.json'), defaultVideoCache);
    const checked = videoCacheSettings.safeParse({...saved,retentionHours:Math.min(24,(saved as any).retentionHours||24)});
    this.state.settings = checked.success ? checked.data : { ...defaultVideoCache };
    this.schedule();
    // Inventory and expiry checks must not delay opening the workspace.
    void this.clean();
  }
  private schedule() {
    if(this.closed)return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(50,Math.min(this.state.settings.cleanupMinutes * 60000,(this.nextExpiry||Infinity)-Date.now()));
    this.state.nextCleanup = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      void this.clean();
    }, delay);
    this.timer.unref();
  }
  noteFrame(at=Date.now()){const expiry=at+this.state.settings.retentionHours*3600000;if(!this.nextExpiry||expiry<this.nextExpiry){this.nextExpiry=expiry;this.schedule();}}
  async configure(settings: VideoCacheSettings) {
    this.state.settings = videoCacheSettings.parse(settings);
    await atomicJson(path.join(this.root, 'video-cache-settings.json'), this.state.settings);
    this.schedule();
    return this.clean();
  }
  clean() {
    return this.writes.run(async () => {
      this.state.cleaning = true;
      this.state.error = '';
      const removed = new Set<string>();
      let freed = 0;
      try {
        const rows: { file: string; metadata: string; size: number; at: number; stamp: string }[] = [];
        for (const source of await fs.readdir(this.root, { withFileTypes: true })) {
          if (!source.isDirectory() || source.isSymbolicLink() || !/^[a-f0-9]{24}$/.test(source.name))
            continue;
          const videos = path.join(this.root, source.name, 'videos');
          let sessions;
          try {
            sessions = await fs.readdir(videos, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const session of sessions) {
            if (!session.isDirectory() || session.isSymbolicLink()) continue;
            const preview = path.join(videos, session.name, 'preview');
            let entries;
            try {
              entries = await fs.readdir(preview, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const entry of entries) {
              if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
              const metadata = path.join(preview, entry.name);
              try {
                const value = JSON.parse(await fs.readFile(metadata, 'utf8'));
                const file = path.resolve(this.root, source.name, value.archivePath || '');
                if (!file.startsWith(preview + path.sep) || !/\.(webp|png|jpg)$/.test(file)) continue;
                const actual = await fs.realpath(file);
                if (actual.toLowerCase() !== file.toLowerCase()) continue;
                const stat = await fs.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink()) continue;
                const stamp = value.cachedAt || value.archivedAt || '';
                const at = Date.parse(stamp);
                if (!Number.isFinite(at)) continue;
                rows.push({ file, metadata, size: stat.size, at, stamp });
              } catch {}
            }
          }
        }
        rows.sort((a, b) => a.at - b.at);
        let total = rows.reduce((n, r) => n + r.size, 0);
        const cutoff = Date.now() - this.state.settings.retentionHours * 3600000,
          budget = this.state.settings.maxMegabytes * 1024 * 1024;
        for (const row of rows) {
          if (row.at >= cutoff && total <= budget) continue;
          try {
            const value = JSON.parse(await fs.readFile(row.metadata, 'utf8'));
            if ((value.cachedAt || value.archivedAt) !== row.stamp) continue;
            await fs.rm(row.file, { force: true });
            await fs.rm(row.metadata, { force: true });
            total -= row.size;
            freed += row.size;
            removed.add(row.file);
          } catch {}
        }
        this.onRemoved(removed);
        const future=rows.filter(row=>!removed.has(row.file)).map(row=>row.at+this.state.settings.retentionHours*3600000).filter(at=>at>Date.now()+100);this.nextExpiry=future.length?Math.min(...future):undefined;
        Object.assign(this.state, {
          lastCleanup: new Date().toISOString(),
          removed: removed.size,
          bytesFreed: freed,
          cachedBytes: total,
          cachedFrames: rows.length - removed.size,
        });
      } catch (e) {
        this.state.error = (e as Error).message;
      } finally {
        this.state.cleaning = false;
        this.schedule();
      }
      return structuredClone(this.state);
    });
  }
  async close() {
    this.closed=true;
    if (this.timer) clearTimeout(this.timer);
    await this.writes.flush();
  }
}
