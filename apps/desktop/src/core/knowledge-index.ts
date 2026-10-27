import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'chokidar';
import { atomicJson, readJson } from './storage';
import type { KnowledgeStatus, KnowledgeHit, SearchMode } from '../shared/knowledge';
export class KnowledgeIndex extends EventEmitter {
  private worker: Worker | null = null;
  private watcher: FSWatcher | undefined;
  private calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private serial = 0;
  private generation = 0;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private embedding = false;
  private autoSemantic = false;
  state: KnowledgeStatus = {
    vaultId: '',
    phase: 'starting',
    files: 0,
    chunks: 0,
    skipped: 0,
    embedded: 0,
    embedding: false,
    message: '尚未连接知识库',
    updatedAt: '',
  };
  embedder?: (texts: string[]) => Promise<number[][]>;
  connectEmbedder(fn: (texts: string[]) => Promise<number[][]>) {
    this.embedder = fn;
    if (this.autoSemantic || this.embedding) {
      this.embedding = true;
      this.state.embedding = true;
      void this.embedLoop(this.generation);
    }
  }
  constructor(
    private data: string,
    private entry: URL,
  ) {
    super();
  }
  async open(root: string, vaultId: string) {
    await this.close();
    await fs.mkdir(this.data, { recursive: true });
    const generation = ++this.generation;
    this.autoSemantic = (
      await readJson<{ semantic: boolean }>(path.join(this.data, vaultId + '.prefs.json'), {
        semantic: false,
      })
    ).semantic;
    this.state = {
      ...this.state,
      vaultId,
      phase: 'starting',
      files: 0,
      chunks: 0,
      skipped: 0,
      embedded: 0,
      embedding: false,
      message: '正在连接后台索引',
    };
    const worker = new Worker(this.entry, {
      workerData: { root, vaultId, file: path.join(this.data, vaultId + '.sqlite') },
    });
    this.worker = worker;
    worker.on('message', (m) => {
      if (generation !== this.generation) return;
      if (m.watchError) {
        this.state.message = '文件监听异常：' + m.watchError;
        this.emit('changed');
        return;
      }
      if (m.status) {
        this.state = { ...m.status, embedding: this.embedding };
        this.emit('changed');
        if (this.autoSemantic && !this.activeEmbedding) {
          this.embedding = true;
          void this.embedLoop(generation);
        }
        return;
      }
      const call = this.calls.get(m.id);
      if (call) {
        this.calls.delete(m.id);
        m.error ? call.reject(Error(m.error)) : call.resolve(m.value);
      }
    });
    worker.on('error', (error: Error) => {
      this.state.phase = 'error';
      this.state.message = error.message;
      for (const call of this.calls.values()) call.reject(error);
      this.calls.clear();
      this.emit('changed');
    });
    void this.rebuild().catch((e) => {
      if (generation === this.generation) {
        this.state.phase = 'error';
        this.state.message = e.message;
        this.emit('changed');
      }
    });
  }
  private call(action: string, args: unknown = {}): Promise<any> {
    if (!this.worker) return Promise.reject(Error('索引尚未就绪'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker!.postMessage({ id, action, args });
    });
  }
  async rebuild() {
    return this.call('scan');
  }
  async search(query: string, mode: SearchMode = 'hybrid', limit = 30): Promise<KnowledgeHit[]> {
    const generation = this.generation,
      keyword = mode === 'semantic' ? [] : await this.call('keyword', { query, limit });
    let semantic: KnowledgeHit[] = [];
    if (mode !== 'keyword' && this.state.embedded) {
      if (!this.embedder) throw Error('本地语义模型尚未连接');
      const [vector] = await this.embedder([query]);
      if (generation !== this.generation) throw Error('知识库已切换');
      semantic = await this.call('semantic', { vector, limit });
    } else if (mode === 'semantic') throw Error('请先建立语义索引，当前全文检索已经可用。');
    if (mode === 'keyword') return keyword;
    if (mode === 'semantic') return semantic;
    const merged = new Map<string, KnowledgeHit>();
    for (const [kind, list] of [
      ['keyword', keyword],
      ['semantic', semantic],
    ] as const)
      list.forEach((hit: KnowledgeHit, index: number) => {
        const old = merged.get(hit.path),
          score = 1 / (60 + index);
        merged.set(hit.path, {
          ...(old || hit),
          score: (old?.score || 0) + score,
          match: old ? 'both' : kind,
        });
      });
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
  backlinks(file: string) {
    return this.call('backlinks', { path: file });
  }
  resolve(base: string, target: string, wiki: boolean) {
    return this.call('resolve', { base, target, wiki });
  }
  issues() {
    return this.call('issues');
  }
  private activeEmbedding = false;
  setEmbedding(enabled: boolean) {
    this.autoSemantic = enabled;
    void atomicJson(path.join(this.data, this.state.vaultId + '.prefs.json'), { semantic: enabled }).catch(
      () => {},
    );
    this.embedding = enabled;
    this.state.embedding = enabled;
    this.emit('changed');
    if (enabled) void this.embedLoop(this.generation);
  }
  private async embedLoop(generation: number) {
    if (this.activeEmbedding || !this.embedder) return;
    this.activeEmbedding = true;
    try {
      while (this.embedding && generation === this.generation) {
        const rows = await this.call('pending', { limit: 8 });
        if (!rows.length) {
          this.embedding = false;
          this.state.embedding = false;
          this.state.message = '全文与语义索引就绪';
          this.emit('changed');
          break;
        }
        const vectors = await this.embedder(rows.map((r: any) => r.text));
        if (generation !== this.generation) break;
        const status = await this.call('vectors', {
          rows: rows.map((r: any, i: number) => ({ id: r.id, vector: vectors[i] })),
        });
        this.state = { ...status, embedding: this.embedding };
        this.emit('changed');
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (e) {
      if (generation === this.generation) {
        this.embedding = false;
        this.state.embedding = false;
        this.state.message = '语义索引暂停：' + (e as Error).message;
        this.emit('changed');
      }
    } finally {
      this.activeEmbedding = false;
      if (this.embedding && generation !== this.generation) void this.embedLoop(this.generation);
    }
  }
  async close() {
    this.generation++;
    this.embedding = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = undefined;
    for (const call of this.calls.values()) call.reject(Error('知识库索引已切换或关闭'));
    this.calls.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
