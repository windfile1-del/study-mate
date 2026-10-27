import { BrowserWindow, session } from 'electron';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { SerialQueue } from '../core/storage';
import { DocumentRegistry } from '../core/document-registry';
import {
  documentCitation,
  type DocumentInfo,
  type DocumentPage,
  type DocumentRegion,
  type DocumentReply,
  type DocumentRequest,
} from '../shared/documents';
export class DocumentService {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private queue = new SerialQueue();
  private loaded = new Set<string>();
  private tokens = new Map<string, string>();
  private cache = new Map<string, DocumentPage>();
  private cacheBytes = 0;
  private passwords = new Map<string, string>();
  constructor(
    readonly registry: DocumentRegistry,
    private url: string,
  ) {
    session.defaultSession.protocol.handle('study-document', async (request) => {
      try {
        const id = this.tokens.get(new URL(request.url).pathname.slice(1));
        if (!id || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
        const file = registry.file(id),
          stat = await fs.stat(file);
        return new Response(
          request.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(file)) as ReadableStream),
          {
            headers: {
              'Content-Length': String(stat.size),
              'Content-Type': 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
            },
          },
        );
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }
  private asset(id: string) {
    let token = [...this.tokens].find(([, value]) => value === id)?.[0];
    if (!token) {
      token = randomUUID();
      this.tokens.set(token, id);
    }
    return 'study-document://asset/' + token;
  }
  private async boot() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const window = new BrowserWindow({
        show: false,
        width: 1600,
        height: 1200,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      this.window = window;
      window.once('closed', () => {
        if (this.window === window) {
          this.window = null;
          this.ready = null;
          this.loaded.clear();
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (e) => e.preventDefault());
      await window.loadURL(this.url);
      await window.webContents.executeJavaScript(
        'new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(window.studyDocumentEngine){clearInterval(timer);resolve(true);}else if(++attempts>200){clearInterval(timer);reject(Error("文档引擎启动超时"));}},50);})',
      );
    })().catch((e) => {
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
      this.window = null;
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  private async execute(action: string, input: unknown, signal?: AbortSignal) {
    await this.boot();
    signal?.throwIfAborted();
    const win = this.window!;
    let rejectStop: (e: Error) => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const reset = () => {
      if (!win.isDestroyed()) win.destroy();
      if (this.window === win) {
        this.window = null;
        this.ready = null;
        this.loaded.clear();
      }
    };
    const cancel = () => {
      reset();
      rejectStop(Error('文档读取已取消。'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      reset();
      rejectStop(Error('文档解析超过60秒，请尝试较小文件或较低缩放。'));
    }, 60000);
    try {
      const result = await Promise.race([
        win.webContents.executeJavaScript(
          `window.studyDocumentEngine.execute(${JSON.stringify(action)},${JSON.stringify(input)})`,
        ),
        stopped,
      ]);
      signal?.throwIfAborted();
      if (!result.ok) throw Error(result.error);
      return result.value;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }
  async open(file: string) {
    const info = await this.registry.register(file);
    return this.inspect(info.id);
  }
  async inspect(id: string, password?: string) {
    const info = this.registry.get(id);
    if (info.kind === 'ppt') return info;
    return this.queue.run(async () => {
      try {
        const result = await this.execute('open', {
          id,
          url: this.asset(id),
          kind: info.kind,
          password: password ?? this.passwords.get(id),
        });
        this.loaded.add(id);
        if (password) this.passwords.set(id, password);
        return this.registry.update(id, {
          pages: result.pages,
          outline: result.outline,
          locked: false,
          warning: info.kind === 'pptx' ? '静态幻灯片预览，复杂效果/字体/公式可能与Office不同。' : '',
        });
      } catch (e) {
        if (e instanceof Error && e.message.includes('PDF_PASSWORD'))
          return this.registry.update(id, {
            locked: true,
            warning: e.message.includes('INVALID')
              ? '密码不正确，请重新输入。'
              : '此 PDF 需要密码，请先在阅读器解锁。',
          });
        throw e;
      }
    });
  }
  private async ensure(id: string) {
    let doc = this.registry.get(id);
    if (!this.loaded.has(id) && doc.kind !== 'ppt') doc = await this.inspect(id);
    if (doc.locked) throw Error('PDF 尚未解锁，请由用户在阅读器输入密码。');
    return doc;
  }
  async page(
    id: string,
    page: number,
    image = true,
    width = 1400,
    region?: DocumentRegion,
    signal?: AbortSignal,
  ): Promise<DocumentReply> {
    const info = await this.ensure(id);
    if (page < 1 || page > info.pages) throw Error(`页码超出范围，文档共 ${info.pages} 页。`);
    if (info.kind === 'ppt') {
      if (image) throw Error('旧版 PPT 当前只有文字简化阅读，不能提供原版面截图。');
      const pages = await this.registry.legacy(id);
      return {
        document: info,
        page: {
          number: page,
          text: pages[page - 1].slice(0, 64000),
          notes: '',
          blocks: [],
          width: 960,
          height: 540,
          gaps: [info.warning],
          citation: documentCitation(id, page),
        },
      };
    }
    const key = JSON.stringify([id, page, image, width, region]);
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { document: info, page: cached };
    }
    return this.queue.run(async () => {
      signal?.throwIfAborted();
      let value: DocumentPage;
      const input = { id, page, image, width, region, job: randomUUID() };
      try {
        value = await this.execute('page', input, signal);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('引擎已释放')) throw e;
        await this.execute(
          'open',
          { id, url: this.asset(id), kind: info.kind, password: this.passwords.get(id) },
          signal,
        );
        value = await this.execute('page', input, signal);
      }
      value.citation = documentCitation(id, page);
      const bytes = JSON.stringify(value).length * 2;
      if (bytes < 10 * 1024 * 1024) {
        if (this.cache.has(key)) this.cacheBytes -= JSON.stringify(this.cache.get(key)).length * 2;
        this.cache.set(key, value);
        this.cacheBytes += bytes;
        while (this.cache.size > 24 || this.cacheBytes > 32 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= JSON.stringify(this.cache.get(oldest)).length * 2;
          this.cache.delete(oldest);
        }
      }
      return { document: info, page: value };
    });
  }
  async request(input: DocumentRequest): Promise<DocumentReply> {
    if (input.action === 'get') {
      let document = this.registry.get(input.id);
      if (document.kind !== 'ppt' && !document.locked && !this.loaded.has(input.id))
        document = await this.inspect(input.id);
      return { document };
    }
    if (input.action === 'unlock') return { document: await this.inspect(input.id, input.password) };
    if (input.action === 'locate') {
      const doc = await this.ensure(input.id);
      if (input.page > doc.pages) throw Error('页码超出文档范围。');
      return { document: await this.registry.update(input.id, { lastPage: input.page }) };
    }
    if (input.action === 'page')
      return this.page(input.id, input.page, input.image, input.width, input.region);
    return this.search(input.id, input.query, input.start, input.limit);
  }
  async search(
    id: string,
    query: string,
    start = 1,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<DocumentReply> {
    const info = await this.ensure(id),
      hits: NonNullable<DocumentReply['hits']> = [];
    const end = Math.min(info.pages, start + limit - 1);
    for (let page = start; page <= end; page++) {
      signal?.throwIfAborted();
      const result = await this.page(id, page, false, 600, undefined, signal),
        text = result.page!.text + '\n' + result.page!.notes,
        at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (at >= 0)
        hits.push({
          page,
          snippet: text.slice(Math.max(0, at - 60), at + 200),
          citation: documentCitation(id, page),
        });
    }
    return { document: info, hits, nextPage: end < info.pages ? end + 1 : null };
  }
  async close() {
    await this.queue.flush();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ready = null;
    this.loaded.clear();
    this.passwords.clear();
  }
}
