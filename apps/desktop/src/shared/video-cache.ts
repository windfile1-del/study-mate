import { z } from 'zod';
export const videoCacheSettings = z
  .object({
    enabled: z.boolean(),
    retentionHours: z.number().int().min(1).max(720),
    maxMegabytes: z.number().int().min(32).max(2048),
    cleanupMinutes: z.number().int().min(1).max(1440),
  })
  .strict();
export type VideoCacheSettings = z.infer<typeof videoCacheSettings>;
export const defaultVideoCache: VideoCacheSettings = {
  enabled: true,
  retentionHours: 168,
  maxMegabytes: 512,
  cleanupMinutes: 10,
};
export const videoCacheRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('configure'), settings: videoCacheSettings }).strict(),
  z.object({ action: z.literal('clean') }).strict(),
]);
export interface VideoCacheState {
  settings: VideoCacheSettings;
  lastCleanup: string | null;
  nextCleanup: string | null;
  removed: number;
  bytesFreed: number;
  cachedBytes: number;
  cachedFrames: number;
  cleaning: boolean;
  error: string;
}
