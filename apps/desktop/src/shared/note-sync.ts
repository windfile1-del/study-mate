import { z } from 'zod';

export const NOTE_SYNC_LIMIT = 24 * 1024 * 1024;
export const syncPath = z.string().min(1).max(500);
export const noteSyncControl = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['state', 'refresh', 'drive-disconnect']) }),
  z.object({ action: z.literal('select'), path: syncPath, enabled: z.boolean() }),
  z.object({ action: z.literal('drive-connect'), credential: z.string().max(16384) }),
]);
export type NoteSyncControl = z.infer<typeof noteSyncControl>;
export interface NoteSyncState {
  notes: { path: string; selected: boolean }[];
  revision: number;
  account: string;
  uploaded: number;
  error: string;
}
export interface ReadingCopy {
  path: string;
  content: string;
  version: string;
  images: Record<string, string>;
  links: Record<string, { path: string; anchor: string }>;
}
export interface ReadingSnapshot {
  schema: 1;
  source: string;
  revision: number;
  notes: ReadingCopy[];
  images: Record<string, { mime: string; data: string }>;
}
