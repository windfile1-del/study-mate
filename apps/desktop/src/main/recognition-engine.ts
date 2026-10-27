import { NativeAsr } from './native-asr';
import { app, BrowserWindow, session, type WebContents } from 'electron';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerialQueue } from '../core/storage';
export class RecognitionEngine {
  private compute: BrowserWindow | null = null;
  private capture: BrowserWindow | null = null;
  private queue = new SerialQueue();
  private allowed: WebContents | null = null;
  private base: string;
  private native: NativeAsr;
  private closing = false;
  constructor(private url: string) {
    this.base = app.isPackaged
      ? path.join(process.resourcesPath, 'local-models')
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/local-models');
    this.native = new NativeAsr(
      path.join(this.base, 'sensevoice'),
      new URL('./asr-worker.js', import.meta.url),
    );
    for (const kind of ['compute', 'capture']) {
      const ses = session.fromPartition('study-recognition-' + kind);
      ses.protocol.handle('study-model', async (request) => {
        try {
          const u = new URL(request.url);
          if (u.hostname !== 'models') return new Response(null, { status: 404 });
          const rel = decodeURIComponent(u.pathname.slice(1)),
            file = path.resolve(this.base, rel);
          if (
            !file.startsWith(path.resolve(this.base) + path.sep) ||
            !/^(Xenova\/paraphrase-multilingual-MiniLM-L12-v2)\/(?:[a-z_]+\.json|onnx\/[a-z_]+\.onnx)$/.test(
              rel,
            )
          )
            return new Response(null, { status: 404 });
          const actual = await fs.realpath(file);
          if (!actual.toLowerCase().startsWith(this.base.toLowerCase() + path.sep))
            return new Response(null, { status: 404 });
          return new Response(Readable.toWeb(createReadStream(actual)) as ReadableStream, {
            headers: {
              'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
            },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      ses.setPermissionRequestHandler((contents, permission, callback) =>
        callback(
          kind === 'capture' &&
            contents === this.capture?.webContents &&
            permission === 'display-capture' &&
            !!this.allowed,
        ),
      );
      ses.setPermissionCheckHandler(
        (contents, permission) =>
          kind === 'capture' &&
          contents === this.capture?.webContents &&
          permission === 'display-capture' &&
          !!this.allowed,
      );
      ses.setDisplayMediaRequestHandler((request, callback) => {
        const target = this.allowed;
        if (
          kind === 'capture' &&
          request.frame === this.capture?.webContents.mainFrame &&
          target &&
          !target.isDestroyed()
        ) {
          try {
            callback({ video: target.mainFrame, audio: target.mainFrame, enableLocalEcho: true });
            return;
          } catch {}
        }
        callback({});
      });
    }
  }
  async models() {
    const exists = (relative: string) =>
      fs.access(path.join(this.base, relative)).then(
        () => true,
        () => false,
      );
    return {
      asr: await exists('sensevoice/model.int8.onnx'),
      embedding: await exists('Xenova/paraphrase-multilingual-MiniLM-L12-v2/onnx/model_quantized.onnx'),
      ocr: true,
    };
  }
  private async boot(kind: 'compute' | 'capture') {
    let win = this[kind];
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        partition: 'study-recognition-' + kind,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this[kind] = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('closed', () => {
      if (this[kind] === win) this[kind] = null;
    });
    await win.loadURL(this.url);
    await win.webContents.executeJavaScript(
      'new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(window.studyRecognition){clearInterval(t);resolve(true);}else if(++n>400){clearInterval(t);reject(Error("本地识别引擎启动超时"));}},50);})',
    );
    return win;
  }
  async run(action: string, input: unknown = {}, signal?: AbortSignal): Promise<any> {
    if (action === 'asr') return this.native.run(input as any);
    const kind = action.startsWith('audio-') ? 'capture' : 'compute';
    const invoke = async () => {
      if (this.closing) throw Error('识别引擎正在关闭');
      signal?.throwIfAborted();
      const win = await this.boot(kind);
      let timer: ReturnType<typeof setTimeout> | undefined,
        abort = () => {};
      const stop = new Promise<never>((_, reject) => {
        abort = () => {
          if (!win.isDestroyed()) win.destroy();
          reject(Error('识别已取消或超时'));
        };
        timer = setTimeout(abort, 180000);
        signal?.addEventListener('abort', abort, { once: true });
      });
      try {
        signal?.throwIfAborted();
        const result = await Promise.race([
          win.webContents.executeJavaScript(
            `window.studyRecognition.execute(${JSON.stringify(action)},${JSON.stringify(input)})`,
            true,
          ),
          stop,
        ]);
        if (!result.ok) throw Error(result.error);
        return result.value;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    };
    return kind === 'compute' ? this.queue.run(invoke) : invoke();
  }
  async start(contents: WebContents) {
    this.allowed = contents;
    try {
      return await this.run('audio-start');
    } catch (e) {
      this.allowed = null;
      throw e;
    }
  }
  async stop() {
    if (this.capture && !this.capture.isDestroyed()) await this.run('audio-stop');
    this.allowed = null;
  }
  async close() {
    this.closing = true;
    await this.native.close();
    this.allowed = null;
    for (const kind of ['capture', 'compute'] as const)
      if (this[kind] && !this[kind]!.isDestroyed()) this[kind]!.destroy();
    await this.queue.flush();
  }
}
