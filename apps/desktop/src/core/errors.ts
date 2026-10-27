import type { Result } from '../shared/contracts';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
export async function resultOf<T>(run: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: { code: error instanceof AppError ? error.code : 'INTERNAL', message: errorMessage(error) },
    };
  }
}
