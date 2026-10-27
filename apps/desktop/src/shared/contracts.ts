import { z } from 'zod';

export const CHANNELS = {
  state: 'app:state',
  videoCache:'video:cache',observerPolicy:'observer:policy',
  chooseDocument: 'document:choose',
  document: 'document:request',
  recognition:'recognition:request',
  knowledge:'knowledge:request',
  chooseVault: 'vault:choose',
  importNotes: 'vault:import',
  importImages: 'vault:import-images',
  openFolder: 'vault:folder',
  openLocal: 'media:open-local',
  openSource: 'media:open-source',
  analyze: 'media:analyze',
  listNotes: 'vault:list',
  readNote: 'vault:read',
  resolveLink: 'vault:resolve-link',
  noteImage: 'vault:image',
  saveNote: 'vault:save',
  searchNotes: 'vault:search',
  openWeb: 'browser:open',
  bounds: 'browser:bounds',
  player: 'browser:player',
  closeWeb: 'browser:close',
  capture: 'learning:capture',
  cancel: 'tasks:cancel',
  dirty: 'app:dirty',
  binding: 'observer:binding',
  observation: 'observer:observation',
  changed: 'app:changed',
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type SourceKind = 'bilibili' | 'web' | 'local-video' | 'pdf';
export interface LearningSource {
  id: string;
  kind: SourceKind;
  canonicalKey: string;
  url: string;
  title: string;
  partIndex?: number;
  platformVideoId?: string;
  localPath?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ObservationBinding {
  sourceId: string;
  visitId: string;
  generation: number;
  url: string;
}
export interface PlaybackState {
  sourceId: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  observedAt: string;
  frameStatus: string;
  subtitleCount: number;
  frameCount: number;
}
export interface ContextAnchor {
  requestId: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  visitId: string;
  generation: number;
  mediaTime: number;
  submittedAt: string;
  evidenceCutoffAt: string;
}
export interface EvidenceFrame {
  id: string;
  timestamp: number;
  width: number;
  height: number;
  data: string | null;
  sceneCut: boolean;
}
export interface LearningContext {
  anchor: ContextAnchor;
  frames: EvidenceFrame[];
  subtitles: Array<{ from: number; to: number; text: string; source: string }>;
  stale: boolean;
  gaps: string[];
}
export interface NoteFile {
  id: string;
  name: string;
  path: string;
  children?: NoteFile[];
}
export interface NoteDocument {
  path: string;
  content: string;
  version: string;
  modifiedAt: string;
}
export interface SearchHit {
  path: string;
  name: string;
  snippet: string;
}
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskInfo {
  id: string;
  label: string;
  status: TaskStatus;
  createdAt: string;
  finishedAt?: string;
  sourceId?: string;
  error?: string;
}
export interface AppState {
  version: string;
  dataDir: string;
  vaultPath: string;
  vaultId: string;
  vaultRevision: number;
  sources: LearningSource[];
  documents: import('./documents').DocumentInfo[];
  knowledge: import('./knowledge').KnowledgeStatus;
  activeBinding: ObservationBinding | null;
  playback: PlaybackState | null;
  tasks: TaskInfo[];
  context: LearningContext | null;
  analysis: MediaAnalysis | null;
  provider: { configured: boolean; label: string };
}
export interface MediaAnalysis {
  id: string;
  sourceId: string;
  title: string;
  createdAt: string;
  duration: number;
  width: number;
  height: number;
  frames: EvidenceFrame[];
}
export interface ImportReport {
  paths: string[];
  errors: string[];
}
export const analysisSchema = z
  .object({
    start: z.number().finite().min(0),
    end: z.number().finite().min(0).nullable(),
    count: z.number().int().min(1).max(12),
  })
  .strict();
export type AnalysisInput = z.infer<typeof analysisSchema>;
export const notePathSchema = z.string().min(1).max(500);
export const saveNoteSchema = z
  .object({
    path: notePathSchema,
    content: z.string().max(2_000_000),
    expectedVersion: z.string().nullable(),
    operationId: z.string().min(1).max(100),
  })
  .strict();
export type SaveNoteInput = z.infer<typeof saveNoteSchema>;
export const boundsSchema = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().min(0).max(10000),
    height: z.number().finite().min(0).max(10000),
    visible: z.boolean(),
  })
  .strict();
const frameSchema = z
  .object({
    timestamp: z.number().finite().min(0),
    width: z.number().int().min(1).max(960),
    height: z.number().int().min(1).max(540),
    data: z.string().startsWith('data:image/webp;base64,').max(4_000_000),
    hash: z.string().regex(/^[01]{64}$/),
    mimeType: z.literal('image/webp'),
    source: z.literal('canvas'),
    qualityLevel: z.literal('preview'),
  })
  .strict();
export const observationSchema = z
  .object({
    binding: z
      .object({ sourceId: z.string(), visitId: z.string(), generation: z.number().int(), url: z.string() })
      .strict(),
    seq: z.number().int().min(0),
    url: z.string().max(4000),
    title: z.string().max(500),
    currentTime: z.number().finite().min(0),
    duration: z.number().finite().min(0),
    paused: z.boolean(),
    playbackRate: z.number().finite().min(0).max(16),
    frameStatus: z.string().max(80),
    frame: frameSchema.nullable(),
    subtitle: z.string().max(5000).nullable(),
    captions:z.array(z.object({from:z.number().finite().min(0),to:z.number().finite().min(0),text:z.string().max(5000),source:z.enum(['text-track','visible-dom'])}).strict()).max(200).optional(),
  })
  .strict();
export type ObservationInput = z.infer<typeof observationSchema>;

export interface StudyMateBridge {
  ai(input: import('./ai').AiRequest): Promise<import('./ai').AiState>;
  state(): Promise<AppState>;
  videoCache(input:import('zod').infer<typeof import('./video-cache').videoCacheRequest>):Promise<import('./video-cache').VideoCacheState>;
  chooseDocument(): Promise<import('./documents').DocumentInfo | null>;
  recognition(input:import('./recognition').RecognitionRequest):Promise<any>;
  knowledge(input:import('./knowledge').KnowledgeRequest):Promise<any>;
  document(input: import('./documents').DocumentRequest): Promise<import('./documents').DocumentReply>;
  chooseVault(): Promise<AppState>;
  importNotes(): Promise<ImportReport>;
  importImages(): Promise<ImportReport>;
  openFolder(path?: string): Promise<void>;
  openLocal(): Promise<AppState>;
  openSource(id: string): Promise<AppState>;
  analyze(input: AnalysisInput): Promise<string>;
  listNotes(): Promise<NoteFile[]>;
  readNote(path: string): Promise<NoteDocument>;
  resolveNoteLink(
    vaultId: string,
    base: string,
    target: string,
    wiki: boolean,
  ): Promise<{ path: string; anchor: string }>;
  noteImage(vaultId: string, base: string, target: string, wiki: boolean): Promise<string>;
  saveNote(input: SaveNoteInput): Promise<NoteDocument>;
  searchNotes(query: string): Promise<SearchHit[]>;
  openWeb(url: string): Promise<AppState>;
  setBrowserBounds(bounds: z.infer<typeof boundsSchema>): Promise<void>;
  player(input: import('./player').PlayerRequest): Promise<import('./player').PlayerState>;
  closeWeb(): Promise<void>;
  captureContext(): Promise<string>;
  cancelTask(taskId: string): Promise<void>;
  setDirty(dirty: boolean | { dirty: boolean; paths: string[] }): Promise<void>;
  onChanged(listener: () => void): () => void;
}
