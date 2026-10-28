import{workspaceResource}from'./workspace-context';
import { z } from 'zod';
import { documentContextSchema } from './documents';
export const panelKind = z.enum(['navigation', 'assistant']);
export type PanelKind = z.infer<typeof panelKind>;
export const panelContext = z
  .object({
    workspace:z.array(workspaceResource).max(2).optional(),
    note: z.string().max(500).nullable(),
    vaultId: z.string().max(80),
    dirtyPaths: z.array(z.string().max(500)).max(100),
    document: documentContextSchema.optional(),
    externalPrompt: z
      .object({
        id: z.string().max(100),
        text: z.string().max(32000),
        instruction: z.string().max(8000).optional(),
        sourceLabel: z.string().max(500).optional(),
        image: z.object({ vaultId: z.string().max(80), path: z.string().max(500) }).optional(),
      })
      .optional(),
  })
  .strict();
export type PanelContext = z.infer<typeof panelContext>;
export const panelRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.enum(['open', 'close', 'dock']), kind: panelKind }).strict(),
  z.object({ action: z.literal('pin'), kind: panelKind, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('form'), kind: panelKind, expanded: z.boolean() }).strict(),
  z.object({ action: z.literal('context'), context: panelContext }).strict(),
  z
    .object({
      action: z.literal('navigate'),
      target: z.enum([
        'home',
        'browser',
        'note',
        'document',
        'video',
        'import-notes',
        'create-note',
        'vault',
        'learning','manage',
        'open-folder',
        'open-document',
        'open-local',
        'note-changed',
      ]),
      id: z.string().max(500).optional(),
      page: z.number().min(0).max(10000000).optional(),
    })
    .strict(),
]);
export interface PanelState {
  panels: Record<PanelKind, { open: boolean; pinned: boolean }>;
  context: PanelContext;
}
export type PanelEvent = {
  type: 'state' | 'closed' | 'dock' | 'navigate';
  kind?: PanelKind;
  state?: PanelState;
  target?: string;
  id?: string;
  page?: number;
};
