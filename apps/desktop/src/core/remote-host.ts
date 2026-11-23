import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { Bonjour, type Service } from 'bonjour-service';
import QRCode from 'qrcode';
import { z } from 'zod';
import { qrPairCode, RemoteAuth, type SecretProtection } from './remote-auth';
import { atomicJson, readJson, SerialQueue } from './storage';
import { AppError } from './errors';
import remoteOpenApi from '../../../../docs/api/study-mate-v1.openapi.json';
import type { RemotePlayback } from './remote-course';
import { RemotePlaybackStore } from './remote-playback';
import {
  chatSubmit,
  noteInkSync,
  noteInkSyncAll,
  playbackStart, playbackProgress, playbackHandoff,
  pairPoll,
  pairSubmit,
  REMOTE_API_VERSION,
  type ChatSubmit,
  type RemoteChatState,
  type RemoteDevice,
  type RemoteEvent,
  type RemoteHostState,
  type RemoteJob,
  type RemoteControl,
  type RemoteVideo, type PlaybackOffer,
} from '../shared/remote';

export interface RemoteBackend {
  videos?(): RemoteVideo[];
  resumePlayback?(offer: PlaybackOffer, assertActive: () => void): Promise<void>;
  vaultId(): string;
  snapshot(): Promise<unknown>;
  notes(): Promise<unknown>;
  note(path: string): Promise<unknown>;
  syncNoteInk?(path: string, pads: unknown[]): Promise<unknown>;
  syncVaultInk?(notes: Record<string, unknown[]>): Promise<unknown>;
  offlineNotes?(source: string, revision: number): Promise<unknown>;
  resolve(base: string, target: string, wiki: boolean): Promise<{ path: string; anchor: string }>;
  image(base: string, target: string, wiki: boolean): Promise<{ bytes: Buffer; mime: string }>;
  search(query: string): Promise<unknown>;
  chat(): Promise<RemoteChatState>;
  send(input: ChatSubmit, device: RemoteDevice): Promise<void>;
  conversation(operation: 'create' | 'switch', id?: string): Promise<RemoteChatState>;
  cancel(): Promise<void>;
  media?(
    id: string,
    range: string | undefined,
    head: boolean,
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  prepareMedia?(id: string): Promise<RemotePlayback>;
  mediaTrack?(
    id: string,
    track: string,
    range: string | undefined,
    head: boolean,
    signal: AbortSignal,
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
}
export function privateAddress(address: string) {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    address === '127.0.0.1'
  );
}
export function interfacePriority(name: string) {
  return /vmware|virtual|vmnet|vpn|tun|tap|蓝牙/i.test(name) ? 100 : /wlan|wi-fi|wifi/i.test(name) ? 0 : 10;
}
export function lanInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, rows]) =>
    (rows || [])
      .filter((r) => r.family === 'IPv4' && !r.internal && privateAddress(r.address))
      .map((r) => ({ name, address: r.address })),
  ).sort((a, b) => interfacePriority(a.name) - interfacePriority(b.name));
}

/** Only explicitly mapped capabilities are exported. No generic IPC/RPC dispatch. */
export class RemoteHost extends EventEmitter {
  readonly auth: RemoteAuth;
  private app: FastifyInstance | null = null;
  private address = '';
  private port = 0;
  private error = '';
  private qr: string | null = null;
  private bonjour: Bonjour | null = null;
  private advertised: Service | null = null;
  private sockets = new Map<WebSocket, { deviceId: string; vaultId: string; bearer: string }>();
  private events: RemoteEvent[] = [];
  private eventBytes = 0;
  private sequence = 0;
  private jobs: RemoteJob[] = [];
  private fingerprints = new Map<string, string>();
  private queue = new SerialQueue();
  private persistQueue = new SerialQueue();
  private jobFile: string;
  private polling: ReturnType<typeof setInterval> | undefined;
  private pollingBusy = false;
  private lastChat: RemoteChatState | null = null;
  private activeJob: string | null = null;
  private attempts = new Map<string, { count: number; at: number }>();
  private root: string;
  private vaultAtStart = '';
  private playback: RemotePlaybackStore;
  private acceptingPlayback = false;
  constructor(
    dataDir: string,
    readonly backend: RemoteBackend,
    protection: SecretProtection,
  ) {
    super();
    this.root = path.join(dataDir, 'remote');
    this.playback = new RemotePlaybackStore(this.root);
    this.auth = new RemoteAuth(this.root, protection);
    this.jobFile = path.join(this.root, 'requests.json');
  }
  async initialize() {
    await this.auth.initialize();
    await this.playback.initialize();
    const saved = await readJson<RemoteJob[] | { jobs: RemoteJob[]; fingerprints: Record<string, string> }>(
      this.jobFile,
      { jobs: [], fingerprints: {} },
    );
    this.jobs = Array.isArray(saved) ? saved : saved.jobs;
    this.fingerprints = new Map(Object.entries(Array.isArray(saved) ? {} : saved.fingerprints));
    for (const j of this.jobs)
      if (j.status === 'running' || j.status === 'accepted') {
        j.status = 'interrupted';
        j.message = '电脑上次退出时请求中断，未自动重发。';
      }
    await this.saveJobs();
  }
  async restore() {
    const settings = await readJson<{ enabled: boolean; address: string }>(
      path.join(this.root, 'settings.json'),
      { enabled: false, address: '' },
    );
    if (settings.enabled && lanInterfaces().some((i) => i.address === settings.address))
      try {
        await this.start(settings.address);
      } catch (e) {
        this.error = (e as Error).message;
      }
  }
  async control(req: RemoteControl) {
    if (req.action === 'accept-playback' || req.action === 'dismiss-playback') {
      const offer = this.playback.pending(this.backend.vaultId(), this.auth.devices()).find((r) => r.id === req.id);
      if (!offer) throw new AppError('NOT_FOUND', '接力请求已失效或设备已撤销。');
      if (req.action === 'accept-playback') {
        if (this.acceptingPlayback) throw new AppError('BUSY', '正在接续课程，请稍候。');
        if (!this.backend.resumePlayback) throw new AppError('MEDIA_UNSUPPORTED', '此电脑不支持播放接力。');
        this.acceptingPlayback = true;
        try {
          const assertActive = () => {
            if (!this.playback.pending(this.backend.vaultId(), this.auth.devices()).some((r) => r.id === offer.id))
              throw new AppError('PERMISSION_DENIED', '接力授权已失效。');
          };
          assertActive(); await this.backend.resumePlayback(offer, assertActive); assertActive();
        } finally { this.acceptingPlayback = false; }
      }
      await this.playback.dismiss(req.id);
    }
    if (req.action === 'enable' && !this.auth.identity) await this.initialize();
    if (req.action === 'enable') {
      await this.start(req.address);
      await atomicJson(path.join(this.root, 'settings.json'), { enabled: true, address: req.address });
    }
    if (req.action === 'disable') {
      await this.stop();
      await atomicJson(path.join(this.root, 'settings.json'), { enabled: false, address: '' });
    }
    if (req.action === 'pair-code') {
      if (!this.app) throw new AppError('HOST_OFFLINE', '请先开启平板连接。');
      const code = this.auth.issueCode([this.address], this.port);
      this.qr = await QRCode.toDataURL(JSON.stringify(qrPairCode(code)), {
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 840,
        color: { dark: '#142b24ff', light: '#ffffffff' },
      });
    }
    if (req.action === 'approve') await this.auth.approve(req.id, this.backend.vaultId());
    if (req.action === 'reject') this.auth.reject(req.id);
    if (req.action === 'grant') await this.auth.grant(req.id, this.backend.vaultId());
    if (req.action === 'revoke') {
      await this.auth.revoke(req.id);
      for (const [s, d] of this.sockets) if (d.deviceId === req.id) s.close(4001, '设备已解除配对');
      const job = this.jobs.find((j) => j.id === this.activeJob && j.deviceId === req.id);
      if (job) {
        job.status = 'cancelled';
        await this.saveJobs();
        await this.backend.cancel();
      }
    }
    this.emit('changed');
    return this.state();
  }
  state(): RemoteHostState {
    return {
      enabled: !!this.app,
      address: this.address,
      port: this.port,
      hostname: this.auth.hostname,
      pin: this.auth.pin,
      interfaces: lanInterfaces(),
      devices: this.auth.devices(),
      pending: this.auth.pending(),
      pairCode: this.auth.currentCode(),
      qr: this.auth.currentCode() ? this.qr : null,
      error: this.error,
      playbackOffers: this.playback.pending(this.backend.vaultId(), this.auth.devices()),
    };
  }
  reportError(error: unknown) {
    this.error = error instanceof Error ? error.message : '平板连接暂时不可用。';
  }
  isRequestActive(id: string, deviceId: string) {
    return (
      this.activeJob === id &&
      this.jobs.some(
        (j) => j.id === id && j.deviceId === deviceId && ['accepted', 'running'].includes(j.status),
      ) &&
      this.auth.devices().some((d) => d.id === deviceId && !d.revoked && d.vaultId === this.backend.vaultId())
    );
  }
  private async saveJobs() {
    await this.persistQueue.run(() =>
      atomicJson(this.jobFile, { jobs: this.jobs, fingerprints: Object.fromEntries(this.fingerprints) }),
    );
  }
  private authorize(request: FastifyRequest) {
    const device = this.auth.authenticate(request.headers.authorization);
    if (device.vaultId !== this.backend.vaultId())
      throw new AppError('STALE_VAULT', '电脑已切换知识库，请在电脑重新授权当前知识库。');
    return device;
  }
  async start(address: string, allowLoopbackForTests = false) {
    if (
      !isIP(address) ||
      (!lanInterfaces().some((i) => i.address === address) &&
        !(allowLoopbackForTests && address === '127.0.0.1'))
    )
      throw new AppError('LAN_ADDRESS', '请选择本机局域网网卡。');
    if (this.app && this.address === address) return;
    await this.stop();
    this.address = address;
    this.vaultAtStart = this.backend.vaultId();
    this.error = '';
    const app = Fastify({
      https: {
        key: this.auth.identity.privateKey,
        cert: this.auth.identity.certificate,
        minVersion: 'TLSv1.2',
      },
      logger: false,
      bodyLimit: 256 * 1024,
      requestTimeout: 30000,
    });
    this.app = app;
    app.setErrorHandler((error, request, reply) => {
      const e = error as Error & { code?: string; statusCode?: number };
      const code =
        error instanceof z.ZodError || e.statusCode === 400 || e.statusCode === 413
          ? 'INVALID_INPUT'
          : error instanceof AppError
            ? e.code!
            : 'INTERNAL';
      if (code === 'INTERNAL') this.emit('service-error', error);
      const status =
        code === 'UNPAIRED'
          ? 401
          : code === 'STALE_VAULT' || code === 'PERMISSION_DENIED'
            ? 403
            : code === 'BUSY' || code === 'STALE_CONTEXT'
              ? 409
              : code === 'NOT_FOUND'
                ? 404
                : code === 'RATE_LIMIT'
                  ? 429
                  : code === 'INTERNAL'
                    ? 500
                    : 400;
      reply.code(status).send({
        error: {
          code,
          message:
            code === 'INTERNAL'
              ? '服务暂时不可用，请查看电脑连接状态。'
              : code === 'INVALID_INPUT'
                ? '请求参数无效，请更新应用或重新操作。'
                : e.message,
        },
      });
    });
    app.addHook('onRequest', async (request, reply) => {
      const ip = request.ip.replace(/^::ffff:/, '');
      if (!privateAddress(ip)) throw new AppError('PERMISSION_DENIED', '此连接不来自受支持的局域网。');
      if (request.headers.origin)
        throw new AppError('PERMISSION_DENIED', '请使用已配对的 Study Mate 客户端。');
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const route = request.url.split('?')[0];
      if (!['/v1/hello', '/v1/pair', '/v1/pair/status', '/v1/auth/refresh'].includes(route))
        this.authorize(request);
      if (route === '/v1/pair' || route === '/v1/auth/refresh') {
        if (this.attempts.size > 256) this.attempts.clear();
        const p = this.attempts.get(ip);
        const row = p && Date.now() - p.at < 60000 ? p : { count: 0, at: Date.now() };
        if (++row.count > 10) throw new AppError('RATE_LIMIT', '尝试过于频繁，请稍后重试。');
        this.attempts.set(ip, row);
      }
    });
    app.get('/v1/hello', async () => ({
      apiVersion: REMOTE_API_VERSION,
      appVersion: '0.14.0',
      serverId: this.auth.identity.serverId,
      hostname: this.auth.hostname,
      capabilities: {
        readOnly: true,
        chat: true,
        notes: true,
        noteInkSync: !!this.backend.syncNoteInk,
        search: true,
        localMedia: !!this.backend.media,
        courseMedia: !!this.backend.prepareMedia,
        playbackProgress: !!this.backend.videos,
        playbackHandoff: !!this.backend.resumePlayback,
      },
    }));
    app.post('/v1/pair', async (request) => {
      const r = pairSubmit.parse(request.body);
      const result = this.auth.begin(r.secret, r.name);
      this.emit('changed');
      return result;
    });
    app.post('/v1/pair/status', async (request) => {
      const r = pairPoll.parse(request.body);
      return this.auth.poll(r.pairingId, r.pollToken);
    });
    app.post('/v1/auth/refresh', async (request) =>
      this.auth.refresh(
        z
          .object({ refreshToken: z.string().min(32).max(128) })
          .strict()
          .parse(request.body).refreshToken,
      ),
    );
    app.get('/v1/session', async () => this.backend.snapshot());
    const video = (id: string) => {
      const row = this.backend.videos?.().find((r) => r.id === id);
      if (!row) throw new AppError('NOT_FOUND', '课程已从电脑资料中移除。');
      if (!row.supported) throw new AppError('MEDIA_UNSUPPORTED', '此来源暂不支持平板播放，请在电脑观看。');
      return row;
    };
    app.get('/v1/videos', async (request) => {
      const device = this.authorize(request);
      return { videos: (this.backend.videos?.() || []).map((row) => ({ ...row, checkpoint: this.playback.checkpoint(device, row.id) })) };
    });
    app.post('/v1/playback/start', async (request) => {
      const input = playbackStart.parse(request.body); video(input.sourceId);
      return this.playback.start(this.authorize(request), input.sourceId);
    });
    app.post('/v1/playback/progress', async (request) => {
      const input = playbackProgress.parse(request.body); video(input.sourceId);
      return { checkpoint: await this.playback.save(this.authorize(request), input) };
    });
    app.post('/v1/playback/handoff', async (request) => {
      const input = playbackHandoff.parse(request.body), source = video(input.sourceId);
      return this.playback.offer(this.authorize(request), input, source.title);
    });
    app.get('/v1/openapi.json', async () => remoteOpenApi);
    app.get('/v1/notes', async () => ({
      notes: await this.backend.notes(),
      vaultId: this.backend.vaultId(),
    }));
    app.get('/v1/notes/offline', async (request) => {
      const query = z.object({ source: z.uuid().optional(), revision: z.coerce.number().int().nonnegative().default(0) }).strict().parse(request.query);
      if (!this.backend.offlineNotes) throw new AppError('NOT_FOUND', '电脑版本不支持笔记同步。');
      return this.backend.offlineNotes(query.source ?? '', query.revision);
    });
    app.post('/v1/notes/read', async (request) => {
      const r = z
        .object({ path: z.string().min(1).max(500) })
        .strict()
        .parse(request.body);
      return this.backend.note(r.path);
    });
    app.post('/v1/notes/ink/sync', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
      if (!this.backend.syncNoteInk) throw new AppError('NOT_FOUND', '电脑版本不支持手写栏同步。');
      const r = noteInkSync.parse(request.body);
      return this.backend.syncNoteInk(r.path, r.pads);
    });
    app.post('/v1/notes/ink/sync-all', { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
      if (!this.backend.syncVaultInk) throw new AppError('NOT_FOUND', '电脑版本不支持手写栏批量同步。');
      const r = noteInkSyncAll.parse(request.body);
      return this.backend.syncVaultInk(r.notes);
    });
    const link = z
      .object({ base: z.string().min(1).max(500), target: z.string().max(2000), wiki: z.boolean() })
      .strict();
    app.post('/v1/notes/resolve', async (request) => {
      const r = link.parse(request.body);
      return this.backend.resolve(r.base, r.target, r.wiki);
    });
    app.get('/v1/notes/image', async (request, reply) => {
      const r = z
        .object({
          base: z.string().min(1).max(500),
          target: z.string().max(2000),
          wiki: z.enum(['true', 'false']),
        })
        .strict()
        .parse(request.query);
      const image = await this.backend.image(r.base, r.target, r.wiki === 'true');
      return reply
        .type(image.mime)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(image.bytes);
    });
    app.post('/v1/knowledge/search', async (request) => ({
      hits: await this.backend.search(
        z
          .object({ query: z.string().min(1).max(200) })
          .strict()
          .parse(request.body).query,
      ),
    }));
    app.get('/v1/conversations', async () => this.backend.chat());
    app.post('/v1/conversations', async (request) => {
      const r = z
        .object({ operation: z.enum(['create', 'switch']), id: z.string().max(100).optional() })
        .strict()
        .parse(request.body);
      if (r.operation === 'switch' && !r.id) throw new AppError('INVALID_INPUT', '请选择对话。');
      if (this.activeJob) throw new AppError('BUSY', '请先等待当前回答结束。');
      return this.backend.conversation(r.operation, r.id);
    });
    app.post('/v1/chat/requests', async (request, reply) => {
      const input = chatSubmit.parse(request.body);
      const result = await this.submit(input, this.authorize(request));
      return reply.code(202).send(result);
    });
    app.get('/v1/chat/requests/:id', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const job = this.jobs.find((j) => j.id === id && j.deviceId === this.authorize(request).id);
      if (!job) throw new AppError('NOT_FOUND', '没有找到这条请求。');
      return job;
    });
    app.post('/v1/chat/requests/:id/cancel', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const job = this.jobs.find((j) => j.id === id && j.deviceId === this.authorize(request).id);
      if (!job) throw new AppError('NOT_FOUND', '没有找到这条请求。');
      if (this.activeJob === id) {
        job.status = 'cancelled';
        await this.backend.cancel();
        await this.saveJobs();
      }
      return job;
    });
    app.route({
      method: ['GET', 'HEAD'],
      url: '/v1/media/:id',
      handler: async (request, reply) => {
        if (!this.backend.media) throw new AppError('MEDIA_UNSUPPORTED', '此电脑尚未提供媒体播放。');
        const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).parse(request.params);
        const media = await this.backend.media(id, request.headers.range, request.method === 'HEAD');
        return reply.code(media.status).headers(media.headers).send(media.body);
      },
    });
    app.post('/v1/media/:id/prepare', async (request) => {
      if (!this.backend.prepareMedia) throw new AppError('MEDIA_UNSUPPORTED', '此电脑暂不支持原生课程播放。');
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).parse(request.params);
      z.object({}).strict().parse(request.body);
      return this.backend.prepareMedia(id);
    });
    app.route({
      method: ['GET', 'HEAD'],
      url: '/v1/media/:id/tracks/:track',
      handler: async (request, reply) => {
        if (!this.backend.mediaTrack) throw new AppError('MEDIA_UNSUPPORTED', '此电脑暂不支持课程流。');
        const { id, track } = z
          .object({ id: z.string().regex(/^[a-f0-9]{24}$/), track: z.string().uuid() })
          .parse(request.params);
        const controller = new AbortController();
        reply.raw.once('close', () => controller.abort());
        const media = await this.backend.mediaTrack(
          id,
          track,
          request.headers.range,
          request.method === 'HEAD',
          controller.signal,
        );
        this.authorize(request);
        return reply.code(media.status).headers(media.headers).send(media.body);
      },
    });
    await app.register(websocket, { options: { maxPayload: 8192 } });
    app.get('/v1/events', { websocket: true }, (socket, request) => {
      const device = this.authorize(request);
      this.sockets.set(socket, {
        deviceId: device.id,
        vaultId: device.vaultId,
        bearer: request.headers.authorization!,
      });
      socket.on('error', () => socket.terminate());
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (bytes) => {
        try {
          this.authorize(request);
          const msg = z
            .object({ after: z.number().int().min(0) })
            .strict()
            .parse(JSON.parse(bytes.toString()));
          const oldest = this.events[0]?.sequence || this.sequence;
          if (msg.after >= oldest - 1 && msg.after <= this.sequence)
            for (const event of this.events.filter((e) => e.sequence > msg.after))
              socket.send(JSON.stringify(event));
          else socket.send(JSON.stringify({ sequence: this.sequence, type: 'reset', data: null }));
        } catch {
          socket.close(1008, '无效事件请求');
        }
      });
      socket.send(JSON.stringify({ sequence: this.sequence, type: 'connected', data: { apiVersion: 1 } }));
    });
    try {
      const url = await app.listen({ host: address, port: 0 });
      this.port = Number(new URL(url).port);
      if (address !== '127.0.0.1') {
        this.bonjour = new Bonjour({}, () => {});
        this.advertised = this.bonjour.publish({
          name: 'Study Mate ' + os.hostname() + ' ' + this.auth.identity.serverId.slice(0, 8),
          type: 'studymate',
          port: this.port,
          host: this.auth.hostname,
          txt: { id: this.auth.identity.serverId, version: '1', address: this.address },
        });
        this.advertised.on('error', () => {});
      }
      this.polling = setInterval(() => void this.pollChat(), 150);
      this.polling.unref();
      this.emit('changed');
    } catch (e) {
      this.app = null;
      await app.close();
      this.error = (e as Error).message;
      throw e;
    }
  }
  private publish(type: string, data: unknown) {
    const event = { sequence: ++this.sequence, type, data };
    this.events.push(event);
    this.eventBytes += Buffer.byteLength(JSON.stringify(event));
    while (this.events.length > 256 || this.eventBytes > 2 * 1024 * 1024) {
      const first = this.events.shift();
      if (first) this.eventBytes -= Buffer.byteLength(JSON.stringify(first));
      else break;
    }
    for (const [s, d] of this.sockets) {
      try {
        this.auth.authenticate(d.bearer);
        if (d.vaultId !== this.backend.vaultId()) throw Error('stale');
        s.send(JSON.stringify(event));
      } catch {
        s.close(4001, '请重新连接并确认授权');
      }
    }
  }
  private async pollChat() {
    if (this.pollingBusy || (!this.sockets.size && !this.activeJob)) return;
    this.pollingBusy = true;
    try {
      const chat = await this.backend.chat();
      if (!this.lastChat || chat.conversationId !== this.lastChat.conversationId)
        this.publish('chat.snapshot', chat);
      else {
        const previous = this.lastChat;
        for (const message of chat.messages) {
          const old = previous.messages.find((m) => m.id === message.id);
          if (!old || JSON.stringify(old) !== JSON.stringify(message)) {
            if (old && message.text.startsWith(old.text))
              this.publish('chat.delta', {
                ...message,
                text: undefined,
                append: message.text.slice(old.text.length),
                offset: old.text.length,
                conversationId: chat.conversationId,
              });
            else this.publish('chat.message', { ...message, conversationId: chat.conversationId });
          }
        }
        if (
          previous.busy !== chat.busy ||
          previous.notice !== chat.notice ||
          JSON.stringify(previous.conversations) !== JSON.stringify(chat.conversations)
        )
          this.publish('chat.status', { ...chat, messages: undefined });
      }
      this.lastChat = structuredClone(chat);
      const job = this.jobs.find((j) => j.id === this.activeJob);
      if (job && job.status !== 'accepted' && !chat.busy) {
        if (job.status !== 'cancelled') {
          const answer = chat.messages.at(-1);
          job.status =
            answer?.status === 'failed'
              ? 'failed'
              : answer?.status === 'cancelled'
                ? 'cancelled'
                : 'complete';
          job.message = answer?.error || '';
        }
        this.activeJob = null;
        await this.saveJobs();
        this.publish('request', job);
      }
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.pollingBusy = false;
    }
  }
  async submit(input: ChatSubmit, device: RemoteDevice) {
    return this.queue.run(async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        prior = this.jobs.find((j) => j.id === input.requestId);
      if (prior) {
        if (
          prior.deviceId !== device.id ||
          (this.fingerprints.has(prior.id) && this.fingerprints.get(prior.id) !== fingerprint)
        )
          throw new AppError('STALE_CONTEXT', '请求编号已用于另一条问题。');
        return prior;
      }
      if (this.activeJob || (await this.backend.chat()).busy)
        throw new AppError('BUSY', '电脑或平板正在生成回答，请等待结束。');
      const chat = await this.backend.chat();
      if (chat.conversationId !== input.conversationId)
        throw new AppError('STALE_CONTEXT', '当前对话已切换，请刷新后重新发送。');
      const job: RemoteJob = {
        id: input.requestId,
        deviceId: device.id,
        conversationId: input.conversationId,
        status: 'accepted',
        createdAt: new Date().toISOString(),
        message: '',
      };
      this.jobs.push(job);
      this.fingerprints.set(job.id, fingerprint);
      this.activeJob = job.id;
      try {
        await this.saveJobs();
      } catch (e) {
        this.jobs.pop();
        this.activeJob = null;
        throw e;
      }
      void (async () => {
        try {
          await this.saveJobs();
          if (!this.isRequestActive(job.id, device.id))
            throw new AppError('PERMISSION_DENIED', '请求已取消或设备授权已撤销。');
          await this.backend.send(input, device);
          if (job.status !== 'cancelled') job.status = 'running';
          await this.saveJobs();
          this.publish('request', job);
          await this.pollChat();
        } catch (e) {
          if (job.status !== 'cancelled') job.status = 'failed';
          job.message = e instanceof AppError ? e.message : '请求未完成，请在电脑检查连接与存储状态。';
          if (!(e instanceof AppError)) this.emit('service-error', e);
          this.activeJob = null;
          await this.saveJobs();
          this.publish('request', job);
        }
      })().catch((e) => this.emit('service-error', e));
      return { ...job };
    });
  }
  notifyResources() {
    if (this.backend.vaultId() !== this.vaultAtStart) {
      this.events = [];
      this.eventBytes = 0;
      this.lastChat = null;
      this.vaultAtStart = this.backend.vaultId();
    }
    this.publish('resources.changed', { vaultId: this.backend.vaultId() });
  }
  notifyInkChanged(vaultId: string, notePath: string) {
    if (!this.app) return;
    this.publish('ink.changed', { vaultId, path: notePath });
  }
  async stop() {
    if (this.polling) clearInterval(this.polling);
    this.polling = undefined;
    for (const [s] of this.sockets) s.terminate();
    this.sockets.clear();
    this.auth.clearSessions();
    this.events = [];
    this.eventBytes = 0;
    this.lastChat = null;
    this.advertised?.stop();
    this.bonjour?.destroy();
    this.advertised = null;
    this.bonjour = null;
    const app = this.app;
    this.app = null;
    this.port = 0;
    this.qr = null;
    if (app) await app.close();
  }
}
