import { Worker } from 'node:worker_threads';
import { SerialQueue } from '../core/storage';
export class NativeAsr {
  private worker: Worker | null = null;
  private language = '';
  private sequence = 0;
  private queue = new SerialQueue();
  private closing = false;
  private pending: { reject: (e: Error) => void } | null = null;
  constructor(
    private models: string,
    private entry: URL,
  ) {}
  run(input: { samples: number[]; language: string }) {
    return this.queue.run(async () => {
      if (this.closing) throw Error('转写引擎正在关闭');
      if (!this.worker || this.language !== input.language) {
        if (this.worker) await this.worker.terminate();
        this.worker = new Worker(this.entry, {
          workerData: { models: this.models, language: input.language },
        });
        this.language = input.language;
        const current = this.worker;
        current.on('error', () => {
          if (this.worker === current) this.worker = null;
        });
        current.on('exit', () => {
          if (this.worker === current) this.worker = null;
        });
      }
      const worker = this.worker,
        id = ++this.sequence,
        buffer = new Float32Array(input.samples).buffer;
      return new Promise<any>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>,
          done = false;
        const finish = (error?: Error, value?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          worker.removeListener('message', message);
          worker.removeListener('error', failed);
          worker.removeListener('exit', exited);
          this.pending = null;
          if (error) reject(error);
          else resolve(value);
        };
        const failed = (e: Error) => {
          if (this.worker === worker) this.worker = null;
          finish(e);
        };
        const exited = (code: number) => failed(Error('转写进程已退出：' + code));
        const message = (m: any) => {
          if (m.id === id) m.error ? finish(Error(m.error)) : finish(undefined, m.value);
        };
        worker.on('message', message);
        worker.once('error', failed);
        worker.once('exit', exited);
        this.pending = { reject: (e) => failed(e) };
        timer = setTimeout(() => {
          void worker.terminate();
          failed(Error('本地语音识别超时，请尝试更短的片段'));
        }, 120000);
        worker.postMessage({ id, samples: buffer }, [buffer]);
      });
    });
  }
  async close() {
    this.closing = true;
    const worker = this.worker;
    this.pending?.reject(Error('转写已停止'));
    this.worker = null;
    if (worker) await worker.terminate();
    await this.queue.flush();
  }
}
