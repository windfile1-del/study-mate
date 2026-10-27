import { z } from 'zod';
export const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001, '选区超出页面');
export type DocumentRegion = z.infer<typeof regionSchema>;
export interface DocumentInfo {
  id: string;
  revision: string;
  title: string;
  kind: 'pdf' | 'pptx' | 'ppt';
  pages: number;
  outline: { title: string; page: number; depth: number }[];
  locked: boolean;
  warning: string;
  lastPage: number;
  size: number;
  createdAt: string;
}
export interface DocumentBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DocumentPage {
  number: number;
  text: string;
  notes: string;
  blocks: DocumentBlock[];
  image?: string;
  width: number;
  height: number;
  gaps: string[];
  citation: string;
  region?: DocumentRegion;
}
export interface DocumentReply {
  document: DocumentInfo;
  page?: DocumentPage;
  hits?: { page: number; snippet: string; citation: string }[];
  nextPage?: number | null;
}
export interface DocumentReader {
  page(
    id: string,
    page: number,
    image?: boolean,
    width?: number,
    region?: DocumentRegion,
    signal?: AbortSignal,
  ): Promise<DocumentReply>;
  search(
    id: string,
    query: string,
    start?: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<DocumentReply>;
}
export const documentContextSchema = z
  .object({
    id: z.string().regex(/^doc-[a-f0-9]{24}$/),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    page: z.number().int().min(1).max(10000),
    selection: z.object({ text: z.string().max(8000), region: regionSchema.optional() }).optional(),
  })
  .strict();
export type DocumentContext = z.infer<typeof documentContextSchema>;
const id = z.string().regex(/^doc-[a-f0-9]{24}$/);
export const documentRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), id }).strict(),
  z
    .object({
      action: z.literal('page'),
      id,
      page: z.number().int().min(1).max(10000),
      width: z.number().int().min(300).max(2400).default(1400),
      image: z.boolean().default(true),
      region: regionSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      id,
      query: z.string().min(1).max(200),
      start: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(30).default(20),
    })
    .strict(),
  z.object({ action: z.literal('unlock'), id, password: z.string().max(200) }).strict(),
  z.object({ action: z.literal('locate'), id, page: z.number().int().min(1).max(10000) }).strict(),
]);
export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export function documentCitation(id: string, page: number) {
  return `study-cite://${id}/${page}`;
}
export function parseDocumentCitation(value: string) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'study-cite:' ||
      !/^doc-[a-f0-9]{24}$/.test(u.hostname) ||
      !/^\/[1-9]\d{0,4}$/.test(u.pathname) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return null;
    return { id: u.hostname, page: Number(u.pathname.slice(1)) };
  } catch {
    return null;
  }
}
