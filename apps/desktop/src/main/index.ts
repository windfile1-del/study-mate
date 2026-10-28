import { app, BrowserWindow, dialog, session, screen } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppKernel } from './kernel';
import { BrowserController } from './browser';
import { registerIpc } from './ipc';
import { CHANNELS } from '../shared/contracts';
import { requireDDrive } from '../core/storage';
import { errorMessage } from '../core/errors';
import { MediaGateway } from './media-gateway';
import { MediaController } from './media';
import { NoteAssets } from './note-assets';
import { DocumentService } from './documents';
import {RecognitionService} from './recognition';
import {RecognitionEngine} from './recognition-engine';
import{FloatingPanels}from'./floating-panels';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = requireDDrive(process.env.STUDYMATE_DATA_DIR || 'D:\\StudyMateData');
const profile = path.join(dataDir, 'profile');
const temporary = path.join(dataDir, 'temp');
for (const dir of [profile, temporary, path.join(dataDir, 'browser'), path.join(dataDir, 'logs')])
  fs.mkdirSync(dir, { recursive: true });
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.env.TMPDIR = temporary;
app.setName('Study Mate');
app.setPath('userData', profile);
app.setPath('sessionData', path.join(dataDir, 'browser'));
app.setPath('temp', temporary);
app.setPath('logs', path.join(dataDir, 'logs'));
app.setPath('crashDumps', path.join(temporary, 'crashes'));
if (process.env.STUDYMATE_SMOKE === '1') app.commandLine.appendSwitch('disable-http-cache');

let window: BrowserWindow | null = null;
let kernel: AppKernel | null = null;
let browser: BrowserController | null = null;
let closing = false;
let closed = false;
let hasDirtyNote = false;
const ownsInstance = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});
const logError = (error: unknown) => {
  const record = JSON.stringify({ at: new Date().toISOString(), message: errorMessage(error) }) + '\n';
  void fsp.appendFile(path.join(dataDir, 'logs', 'app.ndjson'), record).catch(() => {});
  console.error(errorMessage(error));
};
process.on('unhandledRejection', logError);

async function boot(): Promise<void> {
  await app.whenReady();
  kernel = new AppKernel(dataDir);
  kernel.on('service-error', logError);
  await kernel.initialize();
  const denyPermissions = (ses: Electron.Session) => {
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
  };
  denyPermissions(session.defaultSession);
  denyPermissions(session.fromPartition('persist:study-mate-browser'));
  const gateway = new MediaGateway();
  gateway.initialize();
  const assets = new NoteAssets(() => kernel!.vault);
  assets.initialize();
  const shellFile = path.join(here, '../renderer/index.html');
  const trustedUrl = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(shellFile).href;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.max(1120, Math.min(1480, workArea.width - 32)),
    height: Math.max(720, Math.min(960, workArea.height - 32)),
    minWidth: 1120,
    minHeight: 720,
    title: 'Study Mate · 学习工作台',
    backgroundColor: '#f8f9f6',
    show: process.env.STUDYMATE_SMOKE !== '1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/shell.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const internalUrl = (name: string) =>
    process.env.ELECTRON_RENDERER_URL
      ? new URL(name, process.env.ELECTRON_RENDERER_URL).href
      : pathToFileURL(path.join(here, '../renderer', name)).href;
  browser = new BrowserController(
    window,
    kernel,
    path.join(here, '../preload/observer.cjs'),
    gateway,
    internalUrl('player.html'),
  );
  const media = new MediaController(kernel, gateway, internalUrl('native-decoder.html'));
  const documents = new DocumentService(kernel.documents, internalUrl('document-engine.html'));
  const recognition=new RecognitionService(kernel,browser,documents,media,new RecognitionEngine(internalUrl('recognition-engine.html')));
  const panels=new FloatingPanels(window,trustedUrl,path.join(here,'../preload/shell.cjs'),kernel.dataDir);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (target.split('#')[0] !== trustedUrl.split('#')[0]) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const closeIpc = registerIpc(
    window,
    kernel,
    browser,
    trustedUrl,
    (dirty) => {
      hasDirtyNote = dirty;
    },
    media,
    assets,
    documents,
    recognition,
    panels,
  );
  let notification: ReturnType<typeof setTimeout> | undefined;
  kernel.on('changed', () => {
    if (notification) return;
    notification = setTimeout(() => {
      notification = undefined;
      if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.changed);
      panels.notify();
    }, 80);
  });
  window.on('close', (event) => {
    if (closed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      if (hasDirtyNote && window) {
        const choice = await browser!.withHiddenView(() =>
          dialog.showMessageBox(window!, {
            type: 'question',
            title: '还有未保存的笔记',
            message: '当前笔记尚未保存。',
            detail: '返回工作台保存或另存副本，避免丢失本次修改。',
            buttons: ['返回保存', '放弃修改并退出'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }),
        );
        if (choice.response === 0) {
          closing = false;
          kernel?.emit('changed');
          return;
        }
      }
      browser?.close();
      await closeIpc().catch(logError);
      await kernel!.close().catch(logError);
      closed = true;
      window?.destroy();
      app.quit();
    })().catch((error) => {
      closing = false;
      logError(error);
    });
  });
  await window.loadURL(trustedUrl);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (window && !window.isDestroyed() && !closed) {
    event.preventDefault();
    window.close();
  }
});
if (!ownsInstance) app.exit(0);
else
  void boot().catch((error) => {
    logError(error);
    if (process.env.STUDYMATE_SMOKE !== '1') dialog.showErrorBox('Study Mate 无法启动', errorMessage(error));
    app.exit(1);
  });
