import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AppKernel } from './kernel';
import type { BrowserController } from './browser';
import type { DocumentService } from './documents';
import type { MediaController } from './media';
import { RecognitionEngine } from './recognition-engine';
import { AudioTimeline, type AudioClock } from '../core/audio-timeline';
import {
  videoCitation,
  type RecognitionState,
  type OcrResult,
  type RecognitionRequest,
  type TranscriptSegment,
} from '../shared/recognition';
import type { DocumentRegion } from '../shared/documents';
import { SerialQueue } from '../core/storage';
export class RecognitionService {
  private timeline = new AudioTimeline();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private packetQueue: { wall: number; samples: number[] }[] = [];
  private pending: {
    epoch: string;
    sourceId: string;
    visitId: string;
    start: number;
    rate: number;
    preservesPitch: boolean;
    samples: Float32Array[];
    length: number;
  } | null = null;
  private captureId = '';
  private recognitionGaps = 0;
  private work = new SerialQueue();
  private inflight = 0;
  private stopped = false;
  private starting = false;
  private captureGeneration = 0;
  private binding: { sourceId: string; visitId: string } | null = null;
  private state: RecognitionState = {
    capturing: false,
    sourceId: null,
    sourceTitle: '',
    language: 'chinese',
    queued: 0,
    processing: false,
    message: '开启采音后，只识别当前课程标签的声音，不采集麦克风或其他软件。',
    gaps: 0,
    segments: [],
    ocr: null,
    models: { asr: false, embedding: false, ocr: true },
  };
  constructor(
    private kernel: AppKernel,
    private browser: BrowserController,
    private documents: DocumentService,
    private media: MediaController,
    readonly engine: RecognitionEngine,
  ) {
    kernel.index.connectEmbedder((texts) => engine.run('embed', { texts }));
  }
  async status() {
    this.state.models = await this.engine.models();
    return structuredClone(this.state);
  }
  async request(input: RecognitionRequest): Promise<any> {
    if (input.action === 'state') return this.status();
    if (input.action === 'start') return this.start(input.language);
    if (input.action === 'stop') {
      await this.stop();
      return this.status();
    }
    if (input.action === 'transcript')
      return this.kernel.recognition.transcript(input.sourceId, input.start, input.end);
    if (input.action === 'ocr-document') return this.ocrDocument(input.id, input.page, input.region);
    if (input.action === 'ocr-image') {
      const vault = this.kernel.vault;
      const file = await vault.imagePath(input.path),
        bytes = await fs.readFile(file);
      if (bytes.length > 20 * 1024 * 1024) throw Error('图片超过20MiB');
      const ext = file.split('.').pop()?.toLowerCase();
      if (ext === 'svg') throw Error('请将SVG先转换为PNG后识别');
      return this.ocr(
        'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + bytes.toString('base64'),
        { kind: 'image', id: input.path, vaultId: vault.id },
      );
    }
    const analysis = await this.media.analyzeForAssistant(
      { start: input.time, end: input.time + 0.2, count: 1 },
      this.browser.view?.webContents,
      input.sourceId,
      new AbortController().signal,
    );
    if (!analysis.frames[0]?.data) throw Error('没有可识别的画面');
    return this.ocr(analysis.frames[0].data, {
      kind: 'video',
      id: input.sourceId,
      time: analysis.frames[0].timestamp,
      citation: videoCitation(input.sourceId, analysis.frames[0].timestamp),
    });
  }
  async start(language: 'chinese' | 'english') {
    if (this.state.capturing || this.starting) throw Error('已经在采集或连接课程音轨');
    if (!(await this.engine.models()).asr) throw Error('随包语音模型缺失，请使用完整软件包');
    const binding = this.kernel.sources.active,
      view = this.browser.view;
    if (!binding || !view || view.webContents.isDestroyed()) throw Error('请先打开并播放课程视频');
    this.stopped = false;
    this.starting = true;
    const generation = ++this.captureGeneration;
    this.binding = { sourceId: binding.sourceId, visitId: binding.visitId };
    this.captureId = randomUUID();
    this.timeline = new AudioTimeline();
    this.recognitionGaps = 0;
    this.packetQueue = [];
    this.pending = null;
    const source = this.kernel.sources.get(binding.sourceId);
    try {
      this.state = {
        ...this.state,
        capturing: false,
        sourceId: source.id,
        sourceTitle: source.title,
        language,
        gaps: 0,
        message: '正在连接当前课程音轨，连接完成后开始采集。',
        segments: (await this.kernel.recognition.transcript(source.id)).slice(-100),
      };
      const result = await this.engine.start(view.webContents);
      if (generation !== this.captureGeneration) throw Error('采音启动已取消');
      if (result.sampleRate !== 16000) throw Error('音频采样率不是16kHz，已停止避免时间错位');
      if (this.kernel.sources.active?.visitId !== binding.visitId) throw Error('课程已切换，请重新开启采音');
      this.state.capturing = true;
      this.state.message = '正在采集当前课程音轨；倍速、跳转与暂停会分段对齐。';
      await this.tick();
      this.timer = setInterval(() => void this.tick(), 200);
    } catch (e) {
      this.state.capturing = false;
      this.binding = null;
      await this.engine.stop().catch(() => {});
      throw e;
    } finally {
      this.starting = false;
    }
    return this.status();
  }
  private async clock(): Promise<AudioClock | null> {
    const active = this.kernel.sources.active,
      view = this.browser.view;
    if (!active || !view || view.webContents.isDestroyed() || active.visitId !== this.binding?.visitId)
      return null;
    const clock = await view.webContents.executeJavaScript(
      '(()=>{const v=[...document.querySelectorAll("video")].sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];return v?{wall:Date.now(),time:v.currentTime,rate:v.playbackRate,paused:v.paused,seeking:v.seeking,preservesPitch:v.preservesPitch}:null;})()',
    );
    return clock ? { ...clock, sourceId: active.sourceId, visitId: active.visitId } : null;
  }
  private async tick() {
    if (this.polling || !this.state.capturing) return;
    this.polling = true;
    try {
      const clock = await this.clock();
      if (!clock) {
        this.state.message = '课程已切换或页面关闭，采音已停止。';
        setTimeout(() => void this.stop(), 0);
        return;
      }
      this.timeline.push(clock);
      const packets = await this.engine.run('audio-pull');
      this.packetQueue.push(...packets);
      while (
        this.packetQueue.length &&
        this.packetQueue[0].wall + this.packetQueue[0].samples.length / 16 <= clock.wall
      ) {
        const packet = this.packetQueue.shift()!;
        for (const span of this.timeline.slice(new Float32Array(packet.samples), packet.wall)) {
          const epoch = this.captureId + ':' + span.epoch;
          if (this.pending && this.pending.epoch !== epoch) this.flush();
          if (!this.pending)
            this.pending = {
              epoch,
              sourceId: span.sourceId,
              visitId: span.visitId,
              start: span.mediaStart,
              rate: span.rate,
              preservesPitch: span.preservesPitch,
              samples: [],
              length: 0,
            };
          this.pending.samples.push(span.samples);
          this.pending.length += span.samples.length;
          if (this.pending.length >= 16000 * 12) this.flush();
        }
      }
      if (clock.paused) this.flush();
      this.state.gaps = this.timeline.gaps + this.recognitionGaps;
    } catch (e) {
      this.state.message = '采音中断：' + (e as Error).message;
      setTimeout(() => void this.stop(), 0);
    } finally {
      this.polling = false;
    }
  }
  private flush() {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.length < 16000 * 0.7) return;
    if (this.inflight >= 6) {
      this.state.message = '识别暂时跟不上播放，已跳过部分音轨；可降低倍速或稍后重新播放该段。';
      this.recognitionGaps++;
      this.state.gaps = this.timeline.gaps + this.recognitionGaps;
      return;
    }
    const samples = new Float32Array(pending.length);
    let at = 0;
    for (const part of pending.samples) {
      samples.set(part, at);
      at += part.length;
    }
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    if (Math.sqrt(energy / samples.length) < 0.002) return;
    const language = this.state.language;
    this.inflight++;
    this.state.queued = this.inflight;
    void this.work
      .run(async () => {
        if (this.stopped) return;
        this.state.processing = true;
        try {
          const result = await this.engine.run('asr', {
            samples: Array.from(samples),
            language,
            rate: pending.rate,
            preservesPitch: pending.preservesPitch,
          });
          if (this.stopped) return;
          const chunks = result.chunks?.length
            ? result.chunks
            : [{ text: result.text, timestamp: [0, samples.length / 16000] }];
          const duration = samples.length / 16000,
            rows: TranscriptSegment[] = chunks
              .filter((c: any) => c.text?.trim())
              .map((c: any) => {
                const from = Math.max(0, Math.min(duration, c.timestamp?.[0] || 0)),
                  to = Math.max(from, Math.min(duration, c.timestamp?.[1] ?? duration)),
                  start = pending.start + from * pending.rate,
                  end = pending.start + to * pending.rate;
                return {
                  id: randomUUID(),
                  sourceId: pending.sourceId,
                  visitId: pending.visitId,
                  epoch: pending.epoch,
                  start,
                  end,
                  text: c.text.trim(),
                  language,
                  confidence: null,
                  warning:
                    '自动转写，未校准置信度；数学术语、倍速和噪声可能导致误识别。时间对齐存在约0.35秒及采音延迟误差。',
                  createdAt: new Date().toISOString(),
                  citation: videoCitation(pending.sourceId, start),
                };
              });
          if (!rows.length) {
            rows.push({
              id: randomUUID(),
              sourceId: pending.sourceId,
              visitId: pending.visitId,
              epoch: pending.epoch,
              start: pending.start,
              end: pending.start + duration * pending.rate,
              text: '',
              language,
              confidence: null,
              gap: true,
              warning:
                '该段音轨未识别出可靠文字，可能包含快语速、噪声或停顿；请核对原音，不代表没有口头讲解。',
              createdAt: new Date().toISOString(),
              citation: videoCitation(pending.sourceId, pending.start),
            });
            this.recognitionGaps++;
            this.state.gaps = this.timeline.gaps + this.recognitionGaps;
          }
          await this.kernel.recognition.append(rows);
          if (this.state.sourceId === pending.sourceId)
            this.state.segments = [...this.state.segments, ...rows].slice(-100);
          this.kernel.emit('changed');
        } catch (e) {
          this.state.message = '转写失败：' + (e as Error).message;
          this.recognitionGaps++;
          this.state.gaps = this.timeline.gaps + this.recognitionGaps;
        } finally {
          this.inflight--;
          this.state.queued = this.inflight;
          this.state.processing = false;
        }
      })
      .catch(() => {});
  }
  async stop() {
    if (this.starting) {
      this.captureGeneration++;
      await this.engine.stop().catch(() => {});
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.state.capturing) {
      for (let i = 0; i < 40 && this.polling; i++) await new Promise((r) => setTimeout(r, 50));
      await this.engine.stop().catch(() => {});
      if (this.kernel.sources.active?.visitId === this.binding?.visitId) await this.tick();
      this.flush();
      this.state.capturing = false;
      this.binding = null;
      if (this.state.message.startsWith('正在采集'))
        this.state.message = '采音已停止，已排队片段会继续完成转写。';
    }
    return this.status();
  }
  async ocrDocument(id: string, page: number, region?: DocumentRegion, signal?: AbortSignal) {
    const reply = await this.documents.page(id, page, true, 1600, region, signal);
    if (!reply.page?.image) throw Error('本页没有可识别的图像');
    return this.ocr(
      reply.page.image,
      { kind: 'document', id, page, citation: reply.page.citation, region },
      signal,
    );
  }
  async ocr(image: string, source: OcrResult['source'], signal?: AbortSignal): Promise<OcrResult> {
    const result = await this.engine.run('ocr', { image }, signal),
      confidence = Number.isFinite(result.confidence) ? result.confidence : 0;
    const row: OcrResult = {
      id: 'ocr-' + randomUUID(),
      text: String(result.text || '').slice(0, 64000),
      confidence,
      lowConfidence: confidence < 70,
      warnings: [
        'OCR文字仅为辅助，公式、手写板书、表格结构和小字请核对原图。',
        ...(confidence < 70 ? ['识别置信较低，请优先核对原图，不将结果当作确定事实。'] : []),
      ],
      source,
      words: result.words.slice(0, 3000),
      createdAt: new Date().toISOString(),
    };
    await this.kernel.recognition.saveOcr(row);
    this.state.ocr = row;
    return row;
  }
  async close() {
    this.captureGeneration++;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state.capturing = false;
    await this.engine.close();
    await this.work.flush();
  }
}
