import { z } from 'zod';
export const playerRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('mode'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('play') }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('seek'), time: z.number().finite().min(0).max(10000000) }).strict(),
  z.object({ action: z.literal('rate'), rate: z.number().finite().min(0.25).max(4) }).strict(),
  z.object({ action: z.literal('subtitles'), enabled: z.boolean() }).strict(),
]);
export type PlayerRequest = z.infer<typeof playerRequestSchema>;
export const playerStateSchema = z.object({
  available: z.boolean(),
  focused: z.boolean(),
  paused: z.boolean(),
  time: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  rate: z.number().finite().min(0.25).max(4),
  subtitles: z.boolean(),
  captionsAvailable: z.boolean(),
  error: z.string().max(500).optional(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;
