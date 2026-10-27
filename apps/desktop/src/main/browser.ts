import { BrowserWindow, WebContentsView } from 'electron';
import type { z } from 'zod';
import { boundsSchema } from '../shared/contracts';
import { normalizeWebUrl } from '../core/sources';
import { AppError } from '../core/errors';
import type { AppKernel } from './kernel';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaGateway, LOCAL_PARTITION } from './media-gateway';
import { playerPage } from './player-page';
import { playerStateSchema, type PlayerRequest, type PlayerState } from '../shared/player';
import{localSubtitles,biliSubtitles}from'./video-subtitles';

export class BrowserController {
  view: WebContentsView | null = null;
  private closing = false;
  private local = false;
  private requestedVisible = false;
  private suspended = 0;
  private localAsset: string | null = null;
  private focusWanted = false;
  constructor(
    private readonly window: BrowserWindow,
    private readonly kernel: AppKernel,
    private readonly preloadPath: string,
    private readonly gateway: MediaGateway,
    private readonly playerUrl: string,
  ) {}
  async open(input: string): Promise<void> {
    const url = normalizeWebUrl(input);
    if (this.view && this.local) this.close();
    this.local = false;
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: {
          preload: this.preloadPath,
          partition: 'persist:study-mate-browser',
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      const view = this.view;
      view.webContents.on('did-finish-load',()=>{const binding=this.kernel.sources.active;if(!binding)return;const source=this.kernel.sources.get(binding.sourceId);if(source.kind==='bilibili')void biliSubtitles(source,view.webContents.session).then(rows=>this.kernel.learning.addSubtitles(source.id,rows)).catch(()=>{});});
      this.window.contentView.addChildView(view);
      view.setBounds({ x: 270, y: 160, width: 700, height: 550 });
      view.setVisible(false);
      view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:\/\//i.test(target))
          void this.open(target).catch((error) => this.kernel.emit('service-error', error));
        return { action: 'deny' };
      });
      view.webContents.on('will-navigate', (event, target) => {
        if (!/^https?:\/\//i.test(target)) event.preventDefault();
      });
      view.webContents.on('will-attach-webview', (event) => event.preventDefault());
      view.webContents.on('did-start-navigation', (_event, target, _inPlace, isMainFrame) => {
        if (isMainFrame && /^https?:\/\//i.test(target)) this.kernel.sources.bind(target);
      });
      view.webContents.on('did-navigate-in-page', (_event, target, isMainFrame) => {
        if (isMainFrame && /^https?:\/\//i.test(target)) this.kernel.sources.bind(target);
      });
      view.webContents.on('page-title-updated', (_event, title) => {
        const active = this.kernel.sources.active;
        if (active) this.kernel.sources.setTitle(active.sourceId, title);
      });
      view.webContents.on('render-process-gone', () => {
        this.kernel.sources.clear();
        this.kernel.emit('service-error', new AppError('PAGE_CRASH', '网页进程已退出，请重新打开课程。'));
      });
      view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3)
          this.kernel.emit('service-error', new AppError('PAGE_LOAD', '网页加载失败：' + description));
      });
    }
    this.kernel.sources.bind(url);
    await this.view.webContents.loadURL(url);
  }
  async openLocal(file: string): Promise<void> {
    const actual = await fs.realpath(file);
    const stat = await fs.stat(actual);
    if (!stat.isFile() || !/\.(mp4|m4v|webm|mkv|mov|ogv|ogg|avi)$/i.test(actual))
      throw new AppError('MEDIA_FILE', '请选择 MP4、WebM 等视频文件。');
    this.close();
    this.local = true;
    this.kernel.sources.bindLocal(actual, stat.size + ':' + stat.mtimeMs);
    this.localAsset = this.gateway.local(actual);
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        partition: LOCAL_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.view = view;
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    const url = new URL(this.playerUrl);
    url.searchParams.set('asset', this.localAsset);
    url.searchParams.set('title', path.basename(actual));
    await view.webContents.loadURL(url.href);
    const sourceId=this.kernel.sources.active?.sourceId;if(sourceId)void localSubtitles(actual).then(rows=>this.kernel.learning.addSubtitles(sourceId,rows)).catch(()=>{});
  }
  async openSource(id: string): Promise<void> {
    const source = this.kernel.sources.get(id);
    if (source.kind === 'local-video' && source.localPath) await this.openLocal(source.localPath);
    else await this.open(source.url);
  }
  async player(command: PlayerRequest): Promise<PlayerState> {
    if (command.action === 'mode') this.focusWanted = command.enabled;
    const view = this.view;
    if (!view || view.webContents.isDestroyed())
      return {
        available: false,
        focused: false,
        paused: true,
        time: 0,
        duration: 0,
        rate: 1,
        subtitles: false,
        captionsAvailable: false,
      };
    const result = await view.webContents.executeJavaScript(
      `(${playerPage.toString()})(${JSON.stringify(command)},${JSON.stringify(this.focusWanted)})`,
      true,
    );
    if (this.view !== view) throw Error('课程已经切换，请重新操作。');
    return playerStateSchema.parse(result);
  }
  async withHiddenView<T>(run: () => Promise<T>): Promise<T> {
    this.suspended++;
    this.view?.setVisible(false);
    try {
      return await run();
    } finally {
      this.suspended--;
      this.view?.setVisible(this.requestedVisible && this.suspended === 0);
    }
  }
  setBounds(input: z.infer<typeof boundsSchema>): void {
    this.requestedVisible = input.visible && input.width > 20 && input.height > 20;
    if (!this.view) return;
    const [width, height] = this.window.getContentSize();
    const x = Math.max(0, Math.min(Math.round(input.x), width));
    const y = Math.max(0, Math.min(Math.round(input.y), height));
    this.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(Math.round(input.width), width - x)),
      height: Math.max(0, Math.min(Math.round(input.height), height - y)),
    });
    this.view.setVisible(this.requestedVisible && this.suspended === 0);
  }
  hide(): void {
    this.view?.setVisible(false);
  }
  close(): void {
    if (!this.view || this.closing) return;
    this.closing = true;
    this.window.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    if (this.localAsset) this.gateway.revoke(this.localAsset);
    this.localAsset = null;
    this.kernel.sources.clear();
    this.closing = false;
  }
}
