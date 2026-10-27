import { ipcMain, dialog, shell as desktopShell, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  CHANNELS,
  boundsSchema,
  observationSchema,
  saveNoteSchema,
  analysisSchema,
} from '../shared/contracts';
import type { MediaController } from './media';
import type { NoteAssets } from './note-assets';
import { resultOf, AppError } from '../core/errors';
import type { BrowserController } from './browser';
import type { AppKernel } from './kernel';
import { AiService } from './ai-service';
import {videoCacheRequest}from'../shared/video-cache';
import { aiRequestSchema } from '../shared/ai';
import { playerRequestSchema } from '../shared/player';
import { documentRequestSchema } from '../shared/documents';
import type { DocumentService } from './documents';
import type {RecognitionService} from './recognition';
import {recognitionRequestSchema} from '../shared/recognition';
import {knowledgeRequestSchema} from '../shared/knowledge';

export function registerIpc(
  window: BrowserWindow,
  kernel: AppKernel,
  browser: BrowserController,
  trustedUrl: string,
  setDirty: (dirty: boolean) => void,
  media: MediaController,
  assets: NoteAssets,
  documents: DocumentService,
  recognition:RecognitionService,
): () => Promise<void> {
  let dirtyPaths: string[] = [];
  const ai = new AiService(kernel, {
    analyze: (input, sourceId, signal) =>
      media.analyzeForAssistant(input, browser.view?.webContents, sourceId, signal),
    dirtyPaths: () => dirtyPaths,
    documents,
    recognition,
  });
  window.once('closed', () => {
    void ai.close();
  });
  const authorizeShell = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (
      event.sender !== window.webContents ||
      !frame ||
      frame !== window.webContents.mainFrame ||
      frame.url.split('#')[0] !== trustedUrl.split('#')[0]
    ) {
      throw new AppError('IPC_DENIED', '此页面无权访问应用服务。');
    }
  };
  const authorizeObserver = (event: IpcMainInvokeEvent) => {
    if (
      !browser.view ||
      event.sender !== browser.view.webContents ||
      event.senderFrame !== browser.view.webContents.mainFrame
    ) {
      throw new AppError('IPC_DENIED', '观察上报不是来自当前课程页面。');
    }
  };
  const shell = (channel: string, run: (input: unknown) => unknown) => {
    ipcMain.handle(channel, (event, input: unknown) =>
      resultOf(() => {
        authorizeShell(event);
        return run(input);
      }),
    );
  };
  shell(CHANNELS.state, () => kernel.state());
  shell(CHANNELS.videoCache,async input=>{const request=videoCacheRequest.parse(input);if(request.action==='configure')return kernel.learning.cache.configure(request.settings);if(request.action==='clean')return kernel.learning.cache.clean();return structuredClone(kernel.learning.cache.state);});
  ipcMain.handle(CHANNELS.observerPolicy,event=>resultOf(()=>{authorizeObserver(event);return{enabled:kernel.learning.cache.state.settings.enabled};}));
  shell(CHANNELS.recognition,input=>recognition.request(recognitionRequestSchema.parse(input)));
  shell(CHANNELS.knowledge,input=>{const request=knowledgeRequestSchema.parse(input);if(request.action==='status')return kernel.index.state;if(request.action==='issues')return kernel.index.issues();if(request.action==='rebuild')return kernel.index.rebuild();if(request.action==='embed'){kernel.index.setEmbedding(request.enabled);return kernel.index.state;}if(request.action==='backlinks')return kernel.index.backlinks(request.path);return kernel.index.search(request.query,request.mode,request.limit);});
  shell(CHANNELS.document, (input) => documents.request(documentRequestSchema.parse(input)));
  shell(CHANNELS.chooseDocument, () =>
    browser.withHiddenView(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '打开 PDF 或 PowerPoint',
        properties: ['openFile'],
        filters: [{ name: 'PDF / PowerPoint', extensions: ['pdf', 'pptx', 'ppt'] }],
      });
      return result.canceled || !result.filePaths[0] ? null : documents.open(result.filePaths[0]);
    }),
  );
  shell('ai:request', (input) => {
    const parsed = aiRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'AI_INPUT',
        '接入参数不符合要求：上下文需为 4096–2000000 的整数；输出需为 256–64000，且小于上下文的一半；单价须为非负数。',
      );
    return ai.request(parsed.data);
  });
  shell(CHANNELS.chooseVault, () =>
    browser.withHiddenView(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择已有 Markdown 知识库文件夹',
        defaultPath: kernel.vault.root,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!result.canceled && result.filePaths[0]) await kernel.setVault(result.filePaths[0]);
      kernel.emit('changed');
      return kernel.state();
    }),
  );
  shell(CHANNELS.importNotes, () =>
    browser.withHiddenView(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '导入 Markdown 文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      return kernel.vault.importFiles(result.canceled ? [] : result.filePaths);
    }),
  );
  shell(CHANNELS.importImages, () =>
    browser.withHiddenView(async () => {
      const vault = kernel.vault;
      const result = await dialog.showOpenDialog(window, {
        title: '导入图片到当前知识库',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp'] }],
      });
      if (vault.id !== kernel.vault.id) throw Error('知识库已切换，请重新导入。');
      return result.canceled ? { paths: [], errors: [] } : vault.importImages(result.filePaths);
    }),
  );
  shell(CHANNELS.openFolder, async (input) => {
    if (input !== undefined)
      desktopShell.showItemInFolder(await kernel.vault.resolveNotePath(z.string().max(500).parse(input)));
    else {
      const error = await desktopShell.openPath(kernel.vault.root);
      if (error) throw new AppError('OPEN_FOLDER', '无法打开目录：' + error);
    }
  });
  shell(CHANNELS.openLocal, () =>
    browser.withHiddenView(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '打开本地视频',
        properties: ['openFile'],
        filters: [{ name: '视频', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'ogg', 'avi'] }],
      });
      if (!result.canceled && result.filePaths[0]) await browser.openLocal(result.filePaths[0]);
      return kernel.state();
    }),
  );
  shell(CHANNELS.openSource, async (input) => {
    await browser.openSource(z.string().max(100).parse(input));
    return kernel.state();
  });
  shell(CHANNELS.analyze, (input) => media.submit(analysisSchema.parse(input), browser.view?.webContents));
  shell(CHANNELS.listNotes, () => kernel.vault.list());
  shell(CHANNELS.readNote, (input) => kernel.vault.read(z.string().min(1).max(500).parse(input)));
  const linkInput = z
    .object({
      vaultId: z.string(),
      base: z.string().min(1).max(500),
      target: z.string().max(2000),
      wiki: z.boolean(),
    })
    .strict();
  shell(CHANNELS.resolveLink, async (input) => {
    const value = linkInput.parse(input);
    if (value.vaultId !== kernel.vault.id)
      throw new AppError('STALE_VAULT', '知识库已切换，请在当前笔记重新打开链接。');
    try{return await kernel.vault.resolveLink(value.base, value.target, value.wiki);}catch(error){
      if(!(error instanceof AppError)||error.code!=='LINK_NOT_FOUND'||!value.wiki)throw error;
      if(value.vaultId!==kernel.vault.id)throw new AppError('STALE_VAULT','知识库已切换');
      const resolved=await kernel.index.resolve(value.base,value.target,value.wiki);
      if(value.vaultId!==kernel.vault.id)throw new AppError('STALE_VAULT','知识库已切换');
      await kernel.vault.resolveNotePath(resolved.path);return resolved;
    }
  });
  shell(CHANNELS.noteImage, (input) => {
    const value = linkInput.parse(input);
    if (value.vaultId !== kernel.vault.id)
      throw new AppError('STALE_VAULT', '知识库已切换，请在当前笔记重新加载图片。');
    return assets.image(value.base, value.target, value.wiki);
  });
  shell(CHANNELS.saveNote, (input) => kernel.vault.write(saveNoteSchema.parse(input)));
  shell(CHANNELS.searchNotes, (input) => kernel.index.search(z.string().max(200).parse(input),'hybrid',30));
  shell(CHANNELS.openWeb, async (input) => {
    await browser.open(z.string().max(4000).parse(input));
    return kernel.state();
  });
  shell(CHANNELS.bounds, (input) => browser.setBounds(boundsSchema.parse(input)));
  shell(CHANNELS.player, (input) => browser.player(playerRequestSchema.parse(input)));
  shell(CHANNELS.closeWeb, () => browser.close());
  shell(CHANNELS.capture, () => kernel.capture());
  shell(CHANNELS.cancel, (input) => kernel.tasks.cancel(z.string().uuid().parse(input)));
  shell(CHANNELS.dirty, (input) => {
    if (typeof input === 'boolean') {
      setDirty(input);
      if (!input) dirtyPaths = [];
    } else {
      const value = z
        .object({ dirty: z.boolean(), paths: z.array(z.string().max(500)).max(100) })
        .strict()
        .parse(input);
      dirtyPaths = value.paths;
      setDirty(value.dirty);
    }
  });
  ipcMain.handle(CHANNELS.binding, (event) =>
    resultOf(() => {
      authorizeObserver(event);
      return kernel.sources.active;
    }),
  );
  ipcMain.handle(CHANNELS.observation, (event, input: unknown) =>
    resultOf(async () => {
      authorizeObserver(event);
      await kernel.learning.observe(observationSchema.parse(input));
      return true;
    }),
  );
  return async () => {
    await ai.close();
    await recognition.close();
    await documents.close();
  };
}
