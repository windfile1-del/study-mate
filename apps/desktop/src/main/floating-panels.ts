import { BrowserWindow, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { atomicJson, readJson, SerialQueue } from '../core/storage';
import { CHANNELS } from '../shared/contracts';
import {
  panelRequest,
  type PanelContext,
  type PanelKind,
  type PanelState,
  type PanelEvent,
} from '../shared/panels';
export class FloatingPanels {
  private windows = new Map<PanelKind, BrowserWindow>();
  private urls = new Map<PanelKind, string>();
  private prefs: Record<string, { bounds: Electron.Rectangle; pinned: boolean }> = {};
  private queue = new SerialQueue();
  private reasons = new Map<PanelKind, 'closed' | 'dock'>();
  private expanded = new Map<PanelKind, Electron.Rectangle>();
  private context: PanelContext = { note: null, vaultId: '', dirtyPaths: [] };
  private ready: Promise<void>;
  constructor(
    private main: BrowserWindow,
    private url: string,
    private preload: string,
    private data: string,
  ) {
    this.ready = readJson<Record<string, { bounds: Electron.Rectangle; pinned: boolean }>>(
      path.join(data, 'panels.json'),
      {},
    ).then((p) => {
      for (const kind of ['navigation', 'assistant']) {
        const value = p[kind];
        if (
          value?.bounds &&
          ['x', 'y', 'width', 'height'].every((key) =>
            Number.isFinite(value.bounds[key as keyof Electron.Rectangle]),
          )
        )
          this.prefs[kind] = { bounds: value.bounds, pinned: !!value.pinned };
      }
    });
  }
  accepts(event: IpcMainInvokeEvent) {
    for (const [kind, win] of this.windows)
      if (
        !win.isDestroyed() &&
        event.sender === win.webContents &&
        event.senderFrame === win.webContents.mainFrame &&
        event.senderFrame.url === this.urls.get(kind)
      )
        return true;
    return false;
  }
  state(): PanelState {
    return {
      panels: {
        navigation: { open: !!this.windows.get('navigation'), pinned: !!this.prefs.navigation?.pinned },
        assistant: { open: !!this.windows.get('assistant'), pinned: !!this.prefs.assistant?.pinned },
      },
      context: this.context,
    };
  }
  private emit(event: PanelEvent) {
    const value = { ...event, state: this.state() };
    if (!this.main.isDestroyed()) this.main.webContents.send(CHANNELS.panelEvent, value);
    for (const win of this.windows.values())
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.panelEvent, value);
  }
  notify() {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send(CHANNELS.changed);
  }
  private persist() {
    return this.queue.run(() => atomicJson(path.join(this.data, 'panels.json'), this.prefs));
  }
  private bounds(value: Partial<Electron.Rectangle>, kind: PanelKind) {
    const area = screen.getDisplayMatching({
      ...this.main.getBounds(),
      ...value,
    } as Electron.Rectangle).workArea;
    const width = Math.min(
        area.width,
        Math.max(kind === 'assistant' ? 350 : 260, value.width || (kind === 'assistant' ? 430 : 310)),
      ),
      height = Math.min(area.height, Math.max(300, value.height || 650));
    return {
      x: Math.max(area.x, Math.min(area.x + area.width - width, value.x ?? area.x + area.width - width - 24)),
      y: Math.max(area.y, Math.min(area.y + area.height - height, value.y ?? area.y + 42)),
      width,
      height,
    };
  }
  async request(raw: unknown, primary: boolean) {
    await this.ready;
    const input = panelRequest.parse(raw);
    if (input.action === 'state') return this.state();
    if (input.action === 'context') {
      if (!primary) throw Error('只有主工作台可发布学习位置');
      this.context = input.context;
      this.emit({ type: 'state' });
      return this.state();
    }
    if (input.action === 'navigate') {
      this.emit({ type: 'navigate', target: input.target, id: input.id, page: input.page });
      if (input.target !== 'note-changed') {
        this.main.show();
        this.main.focus();
      }
      return this.state();
    }
    const kind = input.kind;
    let win = this.windows.get(kind);
    if (input.action === 'open') {
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        return this.state();
      }
      const saved = this.prefs[kind],
        url = new URL(this.url);
      url.searchParams.set('panel', kind);
      this.urls.set(kind, url.href);
      win = new BrowserWindow({
        ...this.bounds(saved?.bounds || {}, kind),
        minWidth: kind === 'assistant' ? 350 : 260,
        minHeight: 300,
        frame: false,
        parent: this.main,
        show: false,
        alwaysOnTop: saved?.pinned || false,
        backgroundColor: '#f3f5f8',
        title: kind === 'assistant' ? 'Study Mate · 伴学浮窗' : 'Study Mate · 导航浮窗',
        webPreferences: {
          preload: this.preload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      this.windows.set(kind, win);
      const panel = win;
      panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      panel.webContents.on('will-navigate', (event, target) => {
        if (target !== url.href) event.preventDefault();
      });
      panel.webContents.on('will-attach-webview', (event) => event.preventDefault());
      const save = () => {
        if (panel.isDestroyed() || this.expanded.has(kind)) return;
        this.prefs[kind] = { bounds: panel.getBounds(), pinned: panel.isAlwaysOnTop() };
        void this.persist();
      };
      panel.on('moved', save);
      panel.on('resized', save);
      panel.on('close', save);
      panel.on('closed', () => {
        this.windows.delete(kind);
        this.expanded.delete(kind);
        const type = this.reasons.get(kind) || 'closed';
        this.reasons.delete(kind);
        this.emit({ type, kind });
      });
      try {
        await panel.loadURL(url.href);
        if (process.env.STUDYMATE_SMOKE !== '1') panel.show();
        save();
        this.emit({ type: 'state' });
      } catch (e) {
        panel.destroy();
        throw e;
      }
      return this.state();
    }
    if (!win || win.isDestroyed()) return this.state();
    if (input.action === 'close' || input.action === 'dock') {
      this.reasons.set(kind, input.action === 'dock' ? 'dock' : 'closed');
      win.close();
    } else if (input.action === 'pin') {
      win.setAlwaysOnTop(input.enabled, 'floating');
      this.prefs[kind] = { bounds: this.expanded.get(kind) || win.getBounds(), pinned: input.enabled };
      await this.persist();
      this.emit({ type: 'state' });
    } else if (input.action === 'form') {
      if (input.expanded && !this.expanded.has(kind)) {
        this.expanded.set(kind, win.getBounds());
        win.setBounds(this.bounds({ ...win.getBounds(), width: 1060, height: 800 }, kind));
      } else if (!input.expanded && this.expanded.has(kind)) {
        const previous = this.expanded.get(kind)!;
        this.expanded.delete(kind);
        win.setBounds(this.bounds(previous, kind));
      }
    }
    return this.state();
  }
  async close() {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.close();
    await this.queue.flush();
  }
}
