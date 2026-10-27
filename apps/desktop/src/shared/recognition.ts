import { z } from 'zod';
import { regionSchema } from './documents';
export interface TranscriptSegment {
  id: string;
  sourceId: string;
  visitId: string;
  epoch: string;
  start: number;
  end: number;
  text: string;
  language: string;
  confidence: null;
  warning: string;
  createdAt: string;
  citation: string;
  gap?: boolean;
}
export interface OcrResult {
  id: string;
  text: string;
  confidence: number;
  lowConfidence: boolean;
  warnings: string[];
  source: {
    kind: 'document' | 'image' | 'video';
    id: string;
    vaultId?: string;
    page?: number;
    time?: number;
    citation?: string;
    region?: z.infer<typeof regionSchema>;
  };
  words: { text: string; confidence: number; x: number; y: number; width: number; height: number }[];
  createdAt: string;
}
export interface RecognitionState {
  capturing: boolean;
  sourceId: string | null;
  sourceTitle: string;
  language: 'chinese' | 'english';
  queued: number;
  processing: boolean;
  message: string;
  gaps: number;
  segments: TranscriptSegment[];
  ocr: OcrResult | null;
  models: { asr: boolean; embedding: boolean; ocr: boolean };
}
export const recognitionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z
    .object({ action: z.literal('start'), language: z.enum(['chinese', 'english']).default('chinese') })
    .strict(),
  z.object({ action: z.literal('stop') }).strict(),
  z
    .object({
      action: z.literal('transcript'),
      sourceId: z.string().regex(/^[a-f0-9]{24}$/),
      start: z.number().min(0).default(0),
      end: z.number().min(0).default(1e9),
    })
    .strict(),
  z
    .object({
      action: z.literal('ocr-document'),
      id: z.string().regex(/^doc-[a-f0-9]{24}$/),
      page: z.number().int().min(1).max(10000),
      region: regionSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal('ocr-image'), path: z.string().min(1).max(500) }).strict(),
  z
    .object({
      action: z.literal('ocr-frame'),
      sourceId: z.string().regex(/^[a-f0-9]{24}$/),
      time: z.number().min(0),
    })
    .strict(),
]);
export type RecognitionRequest = z.infer<typeof recognitionRequestSchema>;
export function videoCitation(id: string, time: number) {
  return `study-video://${id}/${time.toFixed(2)}`;
}
export function parseVideoCitation(value: string) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'study-video:' ||
      !/^([a-f0-9]{24})$/.test(u.hostname) ||
      !/^\/\d+(?:\.\d{1,3})?$/.test(u.pathname) ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      return null;
    return { id: u.hostname, time: Number(u.pathname.slice(1)) };
  } catch {
    return null;
  }
}
