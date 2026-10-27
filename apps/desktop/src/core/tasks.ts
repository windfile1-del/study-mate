import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { TaskInfo } from '../shared/contracts';
import { atomicJson, readJson, SerialQueue } from './storage';
import { AppError, errorMessage } from './errors';

type Job<T> = {
  info: TaskInfo;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
export interface TaskHandle<T> {
  id: string;
  done: Promise<T>;
}
export class TaskManager extends EventEmitter {
  private history: TaskInfo[] = [];
  private waiting: Job<unknown>[] = [];
  private live = new Map<string, Job<unknown>>();
  private running = 0;
  private writes = new SerialQueue();
  private persistenceError: unknown;
  private closing = false;
  constructor(
    private readonly stateFile: string,
    private readonly concurrency = 2,
  ) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('任务并发必须大于零。');
  }
  async initialize(): Promise<void> {
    const saved = await readJson<TaskInfo[]>(this.stateFile, []);
    if (!Array.isArray(saved)) throw new AppError('STORAGE_CORRUPT', '任务记录格式不正确。');
    this.history = saved.slice(-30).map((info) =>
      ['running', 'queued'].includes(info.status)
        ? {
            ...info,
            status: 'interrupted',
            finishedAt: new Date().toISOString(),
            error: '应用已重启，此任务未自动重放。',
          }
        : info,
    );
    await this.persist();
  }
  list(): TaskInfo[] {
    return this.history
      .slice(-30)
      .reverse()
      .map((t) => ({ ...t }));
  }
  submit<T>(label: string, run: (signal: AbortSignal) => Promise<T>, sourceId?: string): TaskHandle<T> {
    if (this.closing) throw new AppError('CLOSING', '应用正在关闭，无法开始新任务。');
    if (this.waiting.length >= 50)
      throw new AppError('QUEUE_FULL', '等待任务过多，请先取消或等待当前任务完成。');
    const info: TaskInfo = {
      id: randomUUID(),
      label,
      status: 'queued',
      sourceId,
      createdAt: new Date().toISOString(),
    };
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A fire-and-observe IPC caller may attach its consumer after submission.
    void done.catch(() => {});
    const job = { info, controller: new AbortController(), run, resolve, reject } as Job<unknown>;
    this.history.push(info);
    this.history = this.history.filter(
      (t) => this.live.has(t.id) || t === info || this.history.indexOf(t) >= this.history.length - 30,
    );
    this.live.set(info.id, job);
    this.waiting.push(job);
    this.changed();
    this.pump();
    return { id: info.id, done };
  }
  cancel(id: string): void {
    const job = this.live.get(id);
    if (!job) return;
    job.controller.abort();
    if (job.info.status === 'queued') {
      this.waiting = this.waiting.filter((j) => j !== job);
      this.finish(job, 'cancelled');
      job.reject(new AppError('CANCELLED', '任务已取消。'));
      this.live.delete(id);
    }
  }
  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      job.info.status = 'running';
      this.changed();
      void (async () => {
        try {
          const value = await this.abortable(job.run(job.controller.signal), job.controller.signal);
          if (job.controller.signal.aborted) throw new AppError('CANCELLED', '任务已取消。');
          this.finish(job, 'succeeded');
          job.resolve(value);
        } catch (error) {
          this.finish(job, job.controller.signal.aborted ? 'cancelled' : 'failed', errorMessage(error));
          job.reject(error);
        } finally {
          this.running--;
          this.live.delete(job.info.id);
          this.pump();
        }
      })();
    }
  }
  private finish(job: Job<unknown>, status: TaskInfo['status'], error?: string): void {
    job.info.status = status;
    job.info.finishedAt = new Date().toISOString();
    job.info.error = error;
    this.changed();
  }
  private abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(new AppError('CANCELLED', '任务已取消。'));
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      work.then(
        (value) => {
          signal.removeEventListener('abort', cancelled);
          if (!signal.aborted) resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', cancelled);
          reject(error);
        },
      );
    });
  }
  private changed(): void {
    void this.persist().catch((error) => {
      this.persistenceError = error;
    });
    this.emit('changed');
  }
  private persist(): Promise<void> {
    const snapshot = this.history.map((t) => ({ ...t }));
    return this.writes.run(() => atomicJson(this.stateFile, snapshot));
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const job of [...this.live.values()]) this.cancel(job.info.id);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.writes.flush();
    if (this.persistenceError) throw this.persistenceError;
  }
}
