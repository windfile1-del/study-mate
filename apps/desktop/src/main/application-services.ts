import path from 'node:path';
import fs from 'node:fs/promises';
import { safeStorage, session } from 'electron';
import { AiService } from './ai-service';
import { ScheduleService } from '../core/schedules';
import { RemoteHost, type RemoteBackend } from '../core/remote-host';
import { AppError } from '../core/errors';
import type { AppKernel } from './kernel';
import type { BrowserController } from './browser';
import type { MediaController } from './media';
import type { DocumentService } from './documents';
import type { RecognitionService } from './recognition';
import type { FloatingPanels } from './floating-panels';
import type { RemoteChatState } from '../shared/remote';
import type { WorkspaceResource } from '../shared/workspace-context';
import { localFileResponse } from '../core/remote-media';
import { RemoteCourseMedia } from '../core/remote-course';
import { NoteSync } from '../core/note-sync';
import { NoteInkService } from '../core/note-ink';
import { NoteDrive } from './note-drive';

/** One lifetime and one AI/scheduler instance for IPC and authenticated LAN calls. */
export class ApplicationServices {
  readonly ai: AiService;
  readonly schedules: ScheduleService;
  readonly schedulesReady: Promise<void>;
  readonly remote: RemoteHost;
  readonly noteSync: NoteSync;
  readonly noteInk: NoteInkService;
  private readonly courseMedia: RemoteCourseMedia;
  dirtyPaths: string[] = [];
  constructor(
    readonly kernel: AppKernel,
    browser: BrowserController,
    media: MediaController,
    documents: DocumentService,
    recognition: RecognitionService,
    panels: FloatingPanels,
  ) {
    this.noteInk = new NoteInkService(kernel.dataDir);
    this.noteSync = new NoteSync(kernel.dataDir, () => kernel.vault, new NoteDrive(kernel.dataDir), this.noteInk);
    this.courseMedia = new RemoteCourseMedia(
      (url, init) => session.fromPartition('persist:study-mate-browser').fetch(url, init),
      (id) => kernel.sources.get(id),
    );
    this.ai = new AiService(kernel, {
      analyze: (input, sourceId, signal) =>
        media.analyzeForAssistant(input, browser.view?.webContents, sourceId, signal),
      dirtyPaths: () => this.dirtyPaths,
      documents,
      recognition,
    });
    this.schedules = new ScheduleService(
      path.join(kernel.dataDir, 'state', 'schedules.json'),
      (task, dueAt, signal) => this.ai.runScheduled(task, dueAt, signal),
    );
    this.ai.schedules = this.schedules;
    this.schedules.on('changed', () => kernel.emit('changed'));
    this.schedules.on('service-error', (e) => kernel.emit('service-error', e));
    this.schedulesReady = this.schedules.initialize();
    this.ai.schedulesReady = this.schedulesReady;
    void this.schedulesReady.catch((e) => kernel.emit('service-error', e));
    const chat = async (): Promise<RemoteChatState> => {
      const s = await this.ai.state();
      return {
        conversationId: s.conversationId,
        conversations: s.conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
        messages: s.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          status: m.status,
          ...(m.error ? { error: m.error } : {}),
          tools: (m.tools || []).map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            summary: t.summary,
          })),
          createdAt: '',
        })),
        busy: s.busy || s.compacting,
        model: s.config.model,
        notice: s.notice,
      };
    };
    const backend: RemoteBackend = {
      videos: () => kernel.sources.list().map((s) => {
        const p = kernel.learning.playback(s.id);
        return { id: s.id, title: s.title, kind: s.kind, supported: s.kind === 'local-video' || s.kind === 'bilibili',
          desktop: p ? { position: p.currentTime, duration: p.duration, rate: p.playbackRate } : null };
      }),
      resumePlayback: async (offer, assertActive) => {
        assertActive();
        if (kernel.sources.active?.sourceId !== offer.sourceId) await browser.openSource(offer.sourceId);
        const binding = kernel.sources.active;
        if (binding?.sourceId !== offer.sourceId) throw new AppError('STALE_CONTEXT', '视频文件或课程已改变，请重新打开。');
        for (let attempt = 0; attempt < 150; attempt++) {
          assertActive();
          if (kernel.sources.active?.visitId !== binding.visitId) throw new AppError('STALE_CONTEXT', '电脑已切换课程，接力已停止。');
          const player = await browser.player({ action: 'state' });
          if (player.available && player.duration > 0) {
            if (offer.position > player.duration + 1) throw new AppError('STALE_CONTEXT', '课程时长已改变，请重新选择进度。');
            await browser.player({ action: 'pause' });
            assertActive();
            await browser.player({ action: 'seek', time: Math.min(offer.position, player.duration) });
            await browser.player({ action: 'rate', rate: offer.rate });
            assertActive();
            await browser.player({ action: 'play' });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new AppError('MEDIA_UNSUPPORTED', '课程尚未就绪，请在电脑确认页面可播放后重试接力。');
      },
      vaultId: () => kernel.vault.id,
      snapshot: async () => {
        const context = panels.state().context;
        return {
          vaultId: kernel.vault.id,
          vaultRevision: kernel.state().vaultRevision,
          workspace: context.workspace || [],
          note: context.note,
          sourceId: kernel.sources.active?.sourceId || null,
          position: kernel.learning.playback()?.currentTime || 0,
          sources: kernel.sources.list().map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
          chat: await chat(),
        };
      },
      notes: () => kernel.vault.list(),
      note: (p) => kernel.vault.read(p),
      syncNoteInk: async (p, pads) => {
        await kernel.vault.resolveNotePath(p);
        return this.noteInk.syncNote(kernel.vault.id, p, pads);
      },
      syncVaultInk: async (notes) => {
        const valid: Record<string, unknown[]> = {};
        for (const [notePath, pads] of Object.entries(notes)) {
          try {
            await kernel.vault.resolveNotePath(notePath);
            valid[notePath] = pads;
          } catch {
            // Skip paths outside current vault cleanly
          }
        }
        return this.noteInk.syncVault(kernel.vault.id, valid);
      },
      offlineNotes: (source, revision) => this.noteSync.read(source, revision),
      resolve: async (base, target, wiki) => {
        try {
          return await kernel.vault.resolveLink(base, target, wiki);
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== 'LINK_NOT_FOUND' || !wiki) throw e;
          const result = await kernel.index.resolve(base, target, wiki);
          await kernel.vault.resolveNotePath(result.path);
          return result;
        }
      },
      image: async (base, target, wiki) => {
        const resolved = await kernel.vault.resolveLink(base, target, wiki),
          file = await kernel.vault.imagePath(resolved.path);
        const mime: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.avif': 'image/avif',
          '.bmp': 'image/bmp',
        };
        return { bytes: await fs.readFile(file), mime: mime[path.extname(file).toLowerCase()] };
      },
      search: (q) => kernel.index.search(q, 'hybrid', 30),
      chat,
      send: async (input, device) => {
        if (device.vaultId !== kernel.vault.id) throw new AppError('STALE_VAULT', '电脑已切换知识库。');
        const workspace: WorkspaceResource[] = [];
        for (const ref of input.context.resources) {
          if (ref.kind === 'note') {
            if (ref.vaultId !== device.vaultId)
              throw new AppError('PERMISSION_DENIED', '笔记不在已授权知识库内。');
            const note = await kernel.vault.read(ref.path);
            if (note.version !== ref.version)
              throw new AppError('STALE_CONTEXT', '笔记已更新，请刷新后重新提问。');
            workspace.push({ kind: 'note', vaultId: ref.vaultId, path: ref.path });
          } else {
            kernel.sources.get(ref.sourceId);
            workspace.push({ kind: 'video', sourceId: ref.sourceId });
          }
        }
        const video = input.context.resources.find((r) => r.kind === 'video');
        await this.ai.request(
          { action: 'send', text: input.text, workspace, course: !!video, allowWrite: false, dirtyPaths: [] },
          {
            deviceId: device.id,
            vaultId: device.vaultId,
            assertActive: () => {
              if (!this.remote.isRequestActive(input.requestId, device.id))
                throw new AppError('PERMISSION_DENIED', '请求已取消或设备授权已撤销。');
            },
            noteVersions: Object.fromEntries(
              input.context.resources.filter((r) => r.kind === 'note').map((r) => [r.path, r.version]),
            ),
            video: video?.kind === 'video' ? video : undefined,
          },
        );
      },
      conversation: async (operation, id) => {
        await this.ai.request({ action: 'conversation', operation, id });
        return chat();
      },
      cancel: async () => {
        await this.ai.request({ action: 'cancel' });
      },
      media: async (id, range, head) => {
        const source = kernel.sources.get(id);
        if (source.kind !== 'local-video' || !source.localPath)
          throw new AppError('MEDIA_UNSUPPORTED', '在线完整播放将在视频阶段启用。');
        const stat = await fs.stat(source.localPath);
        if (!source.canonicalKey.endsWith(':' + stat.size + ':' + stat.mtimeMs))
          throw new AppError('STALE_CONTEXT', '视频文件已改变，请在电脑重新打开。');
        return localFileResponse(source.localPath, range, head);
      },
      prepareMedia: async (id) => {
        const source = kernel.sources.get(id);
        if (source.kind === 'local-video' && source.localPath) {
          const stat = await fs.stat(source.localPath);
          if (!source.canonicalKey.endsWith(':' + stat.size + ':' + stat.mtimeMs))
            throw new AppError('STALE_CONTEXT', '视频文件已改变，请在电脑重新打开。');
        }
        return this.courseMedia.prepare(id);
      },
      mediaTrack: (id, track, range, head, signal) => this.courseMedia.read(id, track, range, head, signal),
    };
    this.remote = new RemoteHost(kernel.dataDir, backend, {
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) throw Error('系统加密不可用，无法建立平板连接。');
        return safeStorage.encryptString(value).toString('base64');
      },
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    });
    this.remote.on('service-error', (e) => kernel.emit('service-error', e));
    this.noteInk.on('changed', (info: { vaultId: string; path: string }) => {
      kernel.emit('changed');
      this.remote.notifyInkChanged(info.vaultId, info.path);
      this.noteSync.schedule();
    });
  }
  async initializeRemote() {
    this.noteSync.start();
    try {
      await this.remote.initialize();
      await this.remote.restore();
    } catch (error) {
      this.remote.reportError(error);
      this.kernel.emit('service-error', error);
    }
  }
  async close() {
    this.courseMedia.clear();
    await this.remote.stop();
    await this.noteSync.close();
    await this.schedules.close();
    await this.ai.close();
  }
}
