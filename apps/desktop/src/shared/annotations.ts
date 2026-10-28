import { z } from 'zod';
export const inkPoint = z
  .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
  .strict();
export const inkStroke = z
  .object({
    id: z.string().min(1).max(80),
    tool: z.enum(['pen', 'line', 'highlight']),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    width: z.number().positive().max(0.05),
    points: z.array(inkPoint).min(1).max(2000),
  })
  .strict();
export type InkStroke = z.infer<typeof inkStroke>;
export type InkTool = 'select' | 'pen' | 'line' | 'highlight' | 'eraser';
const common = {
  id: z.string().regex(/^doc-[a-f0-9]{24}$/),
  page: z.number().int().min(1).max(10000),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
};
export const annotationRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), ...common }).strict(),
  z
    .object({
      action: z.literal('save'),
      ...common,
      version: z.number().int().min(0),
      strokes: z.array(inkStroke).max(1000),
    })
    .strict(),
]);
export interface AnnotationPage {
  version: number;
  revision: string;
  strokes: InkStroke[];
  updatedAt: string | null;
}
