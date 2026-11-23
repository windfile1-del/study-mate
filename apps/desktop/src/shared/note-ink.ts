import { z } from 'zod';

export const NOTE_INK_MAX_PADS = 40;
export const NOTE_INK_MAX_STROKES = 1000;
export const NOTE_INK_MAX_POINTS_PER_STROKE = 2000;
export const NOTE_INK_MAX_TOTAL_POINTS = 80_000;
export const NOTE_INK_MAX_BYTES = 2 * 1024 * 1024;
export const NOTE_INK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const inkToolKindSchema = z.enum([
  'pen',
  'fountain',
  'ballpoint',
  'pencil',
  'marker',
  'highlight',
  'line',
]);

export const padBackgroundSchema = z.enum(['blank', 'grid', 'ruled', 'dot']);
export const padAnchorTypeSchema = z.enum(['top', 'heading', 'block', 'bottom']);

export const inkPointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    p: z.number().finite().min(0).max(2).optional(),
    t: z.number().finite().min(0).optional(),
  })
  .strict();

export const inkStrokeSchema = z
  .object({
    id: z.string().min(1).max(120),
    tool: inkToolKindSchema,
    color: z.string().min(1).max(40),
    width: z.number().finite().min(0.2).max(120),
    opacity: z.number().finite().min(0.05).max(1).optional(),
    pressureSensitivity: z.number().finite().min(0).max(2).optional(),
    points: z.array(inkPointSchema).min(1).max(NOTE_INK_MAX_POINTS_PER_STROKE),
  })
  .strict();

export const handwritingPadSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().max(200),
    anchorType: padAnchorTypeSchema,
    anchorHeadingId: z.string().max(200),
    anchorHeadingText: z.string().max(300),
    anchorBlockIndex: z.number().int().min(0).max(100_000).optional(),
    anchorBlockText: z.string().max(300).optional(),
    anchorBlockOffset: z.number().int().min(0).max(100_000).optional(),
    logicalHeight: z.number().finite().min(120).max(3000),
    background: padBackgroundSchema,
    collapsed: z.boolean(),
    strokes: z.array(inkStrokeSchema).max(NOTE_INK_MAX_STROKES),
    createdAt: z.number().finite().min(0),
    updatedAt: z.number().finite().min(0),
    deletedAt: z.number().finite().min(0).optional(),
  })
  .strict();

export type SharedInkPoint = z.infer<typeof inkPointSchema>;
export type SharedInkStroke = z.infer<typeof inkStrokeSchema>;
export type SharedHandwritingPad = z.infer<typeof handwritingPadSchema>;

export const handwritingPadListSchema = z
  .array(handwritingPadSchema)
  .max(NOTE_INK_MAX_PADS)
  .superRefine((pads, ctx) => {
    let totalPoints = 0;
    for (const pad of pads) {
      for (const stroke of pad.strokes) {
        totalPoints += stroke.points.length;
        if (totalPoints > NOTE_INK_MAX_TOTAL_POINTS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '手写笔迹总点数超出限制。',
          });
          return;
        }
      }
    }
  });

export const noteInkRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('load'),
      vaultId: z.string().min(1).max(120),
      path: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal('save'),
      vaultId: z.string().min(1).max(120),
      path: z.string().min(1).max(500),
      pads: handwritingPadListSchema,
    })
    .strict(),
]);

export type NoteInkRequest = z.infer<typeof noteInkRequestSchema>;

export interface NoteInkResponse {
  vaultId: string;
  path: string;
  pads: SharedHandwritingPad[];
  updatedAt: number;
}

export interface VaultInkDriveDocument {
  schema: 1;
  source: string;
  updatedAt: number;
  notes: Record<string, SharedHandwritingPad[]>;
}

export function padVersionTimestamp(pad: Pick<SharedHandwritingPad, 'updatedAt' | 'deletedAt'>): number {
  return Math.max(pad.updatedAt || 0, pad.deletedAt || 0);
}

/**
 * Conflict-free per-pad LWW merge with tombstone preservation.
 * Neither side silently overwrites pads created on the other device.
 */
export function mergeHandwritingPads<
  T extends Pick<SharedHandwritingPad, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'strokes'>,
>(localPads: readonly T[], remotePads: readonly T[], now = Date.now()): T[] {
  const byId = new Map<string, T>();

  const consider = (candidate: T) => {
    if (!candidate || !candidate.id) return;
    const existing = byId.get(candidate.id);
    if (!existing) {
      byId.set(candidate.id, candidate);
      return;
    }
    const existingTs = padVersionTimestamp(existing);
    const candidateTs = padVersionTimestamp(candidate);
    if (candidateTs > existingTs) {
      byId.set(candidate.id, candidate);
      return;
    }
    if (candidateTs < existingTs) return;

    // Equal timestamps: deterministic tie-break (deletion wins, otherwise more strokes)
    const existingDeleted = typeof existing.deletedAt === 'number' && existing.deletedAt > 0;
    const candidateDeleted = typeof candidate.deletedAt === 'number' && candidate.deletedAt > 0;
    if (candidateDeleted && !existingDeleted) {
      byId.set(candidate.id, candidate);
    } else if (!candidateDeleted && !existingDeleted && candidate.strokes.length > existing.strokes.length) {
      byId.set(candidate.id, candidate);
    }
  };

  for (const pad of localPads) consider(pad);
  for (const pad of remotePads) consider(pad);

  const merged = Array.from(byId.values())
    .filter((pad) => {
      if (typeof pad.deletedAt === 'number' && pad.deletedAt > 0) {
        return now - pad.deletedAt <= NOTE_INK_TOMBSTONE_TTL_MS;
      }
      return true;
    })
    .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));

  return merged.slice(0, NOTE_INK_MAX_PADS);
}

export function activeHandwritingPads<T extends Pick<SharedHandwritingPad, 'deletedAt'>>(
  pads: readonly T[],
): T[] {
  return pads.filter((p) => !(typeof p.deletedAt === 'number' && p.deletedAt > 0));
}
