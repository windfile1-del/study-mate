import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AppState, LearningContext, MediaAnalysis } from '../shared/contracts';
import { MediaStore } from '../core/media-store';
import { SourceRegistry } from '../core/sources';
import { TaskManager } from '../core/tasks';
import { VaultService } from '../core/vault';
import { LearningService } from '../core/learning';
import { AgentRuntime, ToolBroker } from '../core/agent';
import { atomicJson, readJson } from '../core/storage';
import { DocumentRegistry } from '../core/document-registry';
import {KnowledgeIndex} from '../core/knowledge-index';
import {RecognitionStore} from '../core/recognition-store';

export class AppKernel extends EventEmitter {
  readonly sources: SourceRegistry;
  readonly tasks: TaskManager;
  readonly learning: LearningService;
  readonly mediaStore: MediaStore;
  readonly documents: DocumentRegistry;
  readonly index:KnowledgeIndex;
  readonly recognition:RecognitionStore;
  analysis: MediaAnalysis | null = null;
  readonly tools: ToolBroker;
  readonly agent: AgentRuntime;
  vault!: VaultService;
  context: LearningContext | null = null;
  providerStatus?: () => AppState['provider'];
  private configFile: string;
  private vaultRevision = 0;
  constructor(readonly dataDir: string) {
    super();
    this.configFile = path.join(dataDir, 'state', 'workspace.json');
    this.documents = new DocumentRegistry(path.join(dataDir, 'documents'));
    this.index=new KnowledgeIndex(path.join(dataDir,'indexes'),new URL('./knowledge-worker.js',import.meta.url));
    this.recognition=new RecognitionStore(path.join(dataDir,'recognition'));
    this.sources = new SourceRegistry(path.join(dataDir, 'state', 'sources.json'));
    this.tasks = new TaskManager(path.join(dataDir, 'state', 'tasks.json'));
    this.mediaStore = new MediaStore(path.join(dataDir, 'native-media'));
    this.learning = new LearningService(path.join(dataDir, 'evidence'), this.sources, this.mediaStore);
    this.tools = new ToolBroker(
      () => this.vault,
      (anchor, signal) => this.learning.context(anchor, signal),
    );
    this.agent = new AgentRuntime(this.tools);
    for (const emitter of [this.sources, this.tasks, this.learning, this.documents,this.index])
      emitter.on('changed', () => this.emit('changed'));
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.documents.initialize();
    await this.recognition.initialize();
    await this.sources.initialize();
    await this.learning.cache.initialize();
    await this.tasks.initialize();
    this.analysis = await this.mediaStore.last().catch((error) => {
      this.emit('service-error', error);
      return null;
    });
    const saved = await readJson<{ vaultPath?: string }>(this.configFile, {});
    const defaultVault = path.join(this.dataDir, 'vault');
    await this.setVault(saved.vaultPath || defaultVault);
    if (!saved.vaultPath && (await this.vault.list()).length === 0) {
      await this.vault.write({
        path: '开始使用.md',
        expectedVersion: null,
        operationId: 'welcome-v1',
        content:
          '# 欢迎来到 Study Mate\n\n这里是你的本地学习知识库。笔记是普通 Markdown 文件，也可在 Obsidian 中打开。\n\n## 开始学习\n\n1. 打开本地视频或 B站课程。\n2. 在右侧设置连接模型，支持主流 API 与 ChatGPT 订阅 SIWC。\n3. 勾选笔记路径后提问，AI 按需读取所需行，不自动发送整库。\n4. 开启「允许保存」后，可让 AI 精确修改、保存或插图；现有原文自动备份。\n5. 使用「图片」导入本地图片，或让支持视觉的模型分析指定视频片段并把画面写入笔记。\n\n工具过程可展开查看；抽帧不代表看完整段视频，当前没有音轨转写。\n',
      });
    }
  }
  async setVault(root: string): Promise<void> {
    const next = await VaultService.open(root, path.join(this.dataDir, 'state'));
    next.on('watch-error', (error) => this.emit('service-error', error));
    try {
      await next.watch();
      await atomicJson(this.configFile, { vaultPath: next.root });
    } catch (error) {
      await next.close();
      throw error;
    }
    await this.vault?.close();
    this.vault = next;
    await this.index.open(next.root,next.id);
    this.vaultRevision++;
    this.vault.on('changed', () => {
      this.vaultRevision++;
      this.emit('changed');
    });
    this.emit('changed');
  }
  state(): AppState {
    return {
      version: '0.10.0-video',
      dataDir: this.dataDir,
      vaultPath: this.vault.root,
      vaultId: this.vault.id,
      vaultRevision: this.vaultRevision,
      sources: this.sources.list(),
      knowledge:{...this.index.state},
      documents: this.documents.list(),
      activeBinding: this.sources.active,
      playback: this.learning.playback(),
      tasks: this.tasks.list(),
      context: this.context,
      analysis: this.analysis,
      provider: this.providerStatus?.() || {
        configured: this.agent.configured,
        label: this.agent.configured ? '模型已连接' : '模型尚未连接',
      },
    };
  }
  capture(): string {
    const anchor = this.learning.freeze();
    const task = this.tasks.submit(
      '读取课程上下文',
      (signal) => this.learning.context(anchor, signal),
      anchor.sourceId,
    );
    void task.done.then(
      (context) => {
        this.context = context;
        this.emit('changed');
      },
      () => this.emit('changed'),
    );
    return task.id;
  }
  async close(): Promise<void> {
    await this.tasks.close();
    await this.learning.close();
    await this.sources.flush();
    await this.vault.close();
    await this.documents.close();
    await this.index.close();
    await this.recognition.close();
  }
}
