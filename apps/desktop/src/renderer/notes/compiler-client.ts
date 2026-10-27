import type { CompiledNote } from './markdown';

type Job = {
  source: string;
  resolve: (result: CompiledNote) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  cancel: () => void;
  partial?: (result: CompiledNote) => void;
};
type Slot = { worker: Worker; job?: Job };
const slots: Slot[] = [],
  queue: Job[] = [];
const cache = new Map<string, CompiledNote>();
let cacheBytes = 0;
function pump() {
  while (queue.length && (slots.length < 2 || slots.some((slot) => !slot.job))) {
    let slot = slots.find((candidate) => !candidate.job);
    if (!slot) {
      slot = { worker: new Worker(new URL('./markdown-worker.ts', import.meta.url), { type: 'module' }) };
      slots.push(slot);
      const current = slot;
      current.worker.onmessage = (event) => {
        const job = current.job;
        if (!job) return;
        if (event.data.partial) {
          job.partial?.(JSON.parse(event.data.json) as CompiledNote);
          return;
        }
        current.job = undefined;
        job.signal.removeEventListener('abort', job.cancel);
        if (event.data.ok) {
          const result = JSON.parse(event.data.json) as CompiledNote;
          const size = result.bytes + job.source.length * 2;
          if (size <= 48 * 1024 * 1024) {
            cache.set(job.source, result);
            cacheBytes += size;
            while (cache.size > 8 || cacheBytes > 48 * 1024 * 1024) {
              const key = cache.keys().next().value!;
              cacheBytes -= cache.get(key)!.bytes + key.length * 2;
              cache.delete(key);
            }
          }
          job.resolve(result);
        } else job.reject(new Error(event.data.error));
        pump();
      };
      current.worker.onerror = (event) => {
        current.job?.reject(new Error(event.message || '后台解析进程异常'));
        current.worker.terminate();
        slots.splice(slots.indexOf(current), 1);
        pump();
      };
    }
    const job = queue.shift()!;
    if (job.signal.aborted) continue;
    slot.job = job;
    slot.worker.postMessage({ source: job.source });
  }
}
export function compileInWorker(
  source: string,
  signal: AbortSignal,
  partial?: (result: CompiledNote) => void,
): Promise<CompiledNote> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const cached = cache.get(source);
  if (cached) {
    cache.delete(source);
    cache.set(source, cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const job: Job = {
      source,
      resolve,
      reject,
      signal,
      partial,
      cancel: () => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        const slot = slots.find((candidate) => candidate.job === job);
        if (slot) {
          slot.worker.terminate();
          slots.splice(slots.indexOf(slot), 1);
        }
        reject(new DOMException('Aborted', 'AbortError'));
        pump();
      },
    };
    signal.addEventListener('abort', job.cancel, { once: true });
    queue.push(job);
    pump();
  });
}
