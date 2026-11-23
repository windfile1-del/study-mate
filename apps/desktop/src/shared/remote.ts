import { z } from 'zod';
import { handwritingPadListSchema } from './note-ink';

export const REMOTE_API_VERSION = 1;
const uuid = z.string().uuid();
export const remoteNoteRef = z
  .object({
    kind: z.literal('note'),
    vaultId: z.string().max(80),
    path: z.string().min(1).max(500),
    version: z.string().max(100),
  })
  .strict();
export const remoteVideoRef = z
  .object({
    kind: z.literal('video'),
    sourceId: z.string().regex(/^[a-f0-9]{24}$/),
    position: z.number().finite().min(0).max(1e7),
    duration: z.number().finite().min(0).max(1e7),
    epoch: z.number().int().min(0).max(1e9),
  })
  .strict();
export const clientStudyContext = z
  .object({ resources: z.array(z.discriminatedUnion('kind', [remoteNoteRef, remoteVideoRef])).max(2) })
  .strict();
export type ClientStudyContext = z.infer<typeof clientStudyContext>;
export const chatSubmit = z
  .object({
    requestId: uuid,
    conversationId: z.string().min(1).max(100),
    text: z.string().min(1).max(32000),
    context: clientStudyContext,
  })
  .strict();
export type ChatSubmit = z.infer<typeof chatSubmit>;
export const playbackStart = z.object({ sourceId: z.string().regex(/^[a-f0-9]{24}$/) }).strict();
export const playbackProgress = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{24}$/),
  sessionId: uuid,
  sequence: z.number().int().nonnegative().max(1e9),
  position: z.number().finite().nonnegative().max(1e7),
  duration: z.number().finite().positive().max(1e7),
  rate: z.number().finite().min(0.25).max(4),
}).strict().refine((p) => p.position <= p.duration + 1, '播放位置超出时长');
export const playbackHandoff = z.object({ requestId: uuid, ...playbackProgress.shape }).strict()
  .refine((p) => p.position <= p.duration + 1, '播放位置超出时长');
export type PlaybackProgress = z.infer<typeof playbackProgress>;
export interface PlaybackCheckpoint {
  sourceId: string; position: number; duration: number; rate: number; updatedAt: string;
}
export interface PlaybackOffer extends PlaybackCheckpoint {
  id: string; deviceId: string; deviceName: string; vaultId: string; title: string;
}
export interface RemoteVideo {
  id: string; title: string; kind: string; supported: boolean;
  desktop: { position: number; duration: number; rate: number } | null;
}
export const pairSubmit = z
  .object({ secret: z.string().min(32).max(128), name: z.string().trim().min(1).max(80) })
  .strict();
export const pairPoll = z.object({ pairingId: uuid, pollToken: z.string().min(32).max(128) }).strict();
export const noteInkSync = z
  .object({
    path: z.string().min(1).max(500),
    pads: handwritingPadListSchema,
  })
  .strict();
export const noteInkSyncAll = z
  .object({
    notes: z.record(z.string().min(1).max(500), handwritingPadListSchema),
  })
  .strict();
export type NoteInkSyncInput = z.infer<typeof noteInkSync>;
export type NoteInkSyncAllInput = z.infer<typeof noteInkSyncAll>;
export const remoteControl = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('enable'), address: z.string().max(80) }).strict(),
  z.object({ action: z.enum(['disable', 'pair-code']) }).strict(),
  z.object({ action: z.enum(['approve', 'reject']), id: uuid }).strict(),
  z.object({ action: z.enum(['revoke', 'grant']), id: uuid }).strict(),
  z.object({ action: z.enum(['accept-playback', 'dismiss-playback']), id: uuid }).strict(),
]);
export type RemoteControl = z.infer<typeof remoteControl>;
export interface RemoteDevice {
  id: string;
  name: string;
  vaultId: string;
  createdAt: string;
  lastSeenAt: string;
  revoked: boolean;
}
export interface PairCredentials {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}
export interface PairCode {
  version: 1;
  serverId: string;
  hostname: string;
  addresses: string[];
  port: number;
  certificate: string;
  pin: string;
  secret: string;
  expiresAt: string;
}
export interface RemoteHostState {
  enabled: boolean;
  address: string;
  port: number;
  hostname: string;
  pin: string;
  interfaces: { name: string; address: string }[];
  devices: RemoteDevice[];
  pending: { id: string; name: string; createdAt: string }[];
  pairCode: PairCode | null;
  qr: string | null;
  error: string;
  playbackOffers: PlaybackOffer[];
}
export interface RemoteMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: string;
  error?: string;
  tools: { id: string; name: string; status: string; summary: string }[];
  createdAt: string;
}
export interface RemoteChatState {
  conversationId: string;
  conversations: { id: string; title: string; updatedAt: string }[];
  messages: RemoteMessage[];
  busy: boolean;
  model: string;
  notice: string;
}
export interface RemoteJob {
  id: string;
  deviceId: string;
  conversationId: string;
  status: 'accepted' | 'running' | 'complete' | 'failed' | 'interrupted' | 'cancelled';
  createdAt: string;
  message: string;
}
export interface RemoteEvent {
  sequence: number;
  type: string;
  data: unknown;
}
