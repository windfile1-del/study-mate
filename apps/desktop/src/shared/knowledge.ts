import { z } from 'zod';
export type SearchMode = 'keyword' | 'semantic' | 'hybrid';
export interface KnowledgeHit {
  path: string;
  name: string;
  snippet: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  match: 'keyword' | 'semantic' | 'both';
}
export interface KnowledgeStatus {
  vaultId: string;
  phase: 'starting' | 'scanning' | 'ready' | 'error';
  files: number;
  chunks: number;
  skipped: number;
  embedded: number;
  embedding: boolean;
  message: string;
  updatedAt: string;
}
export interface Backlink {
  path: string;
  name: string;
  line: number;
  target: string;
  resolved: boolean;
}
export const knowledgeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('rebuild') }).strict(),
  z.object({ action: z.literal('issues') }).strict(),
  z.object({ action: z.literal('embed'), enabled: z.boolean() }).strict(),
  z
    .object({
      action: z.literal('search'),
      query: z.string().min(1).max(200),
      mode: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid'),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  z.object({ action: z.literal('backlinks'), path: z.string().min(1).max(500) }).strict(),
]);
export type KnowledgeRequest = z.infer<typeof knowledgeRequestSchema>;
