import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';

export function requireDDrive(target: string): string {
  const resolved = path.resolve(target);
  if (process.platform === 'win32' && !/^d:\\/i.test(resolved)) {
    throw new AppError('DATA_DIRECTORY', '请选择 D 盘目录，应用临时文件仅保存在 D 盘。');
  }
  return resolved;
}
export async function atomicJson(target: string, value: unknown): Promise<void> {
  requireDDrive(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
export async function readJson<T>(target: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new AppError('STORAGE_CORRUPT', '本地状态文件无法读取。请保留该文件并从备份恢复。');
  }
}
export class SerialQueue {
  private pending: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }
  async flush(): Promise<void> {
    await this.pending;
  }
}
