import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AudioLines,
  ScanText,
  Search,
  Database,
  Network,
  Mic,
  Square,
  Play,
  RefreshCw,
  X,
  LoaderCircle,
  ImagePlus,
  ShieldCheck,
} from 'lucide-react';
import type { AppState } from '../../shared/contracts';
import type { RecognitionState, OcrResult } from '../../shared/recognition';
import type { KnowledgeHit, Backlink, SearchMode } from '../../shared/knowledge';
import './learning.css';
import{VideoCacheSettings}from'./VideoCacheSettings';
const api = window.studyMate;
const time = (n: number) =>
  `${Math.floor(n / 60)}:${Math.floor(n % 60)
    .toString()
    .padStart(2, '0')}`;
export function LearningPanel({
  state,
  note,
  onClose,
  onOpenNote,
  onVideo,
  onDocument,
  onAskImage,
}: {
  state: AppState | null;
  note: string | null;
  onClose: () => void;
  onOpenNote: (p: string) => void;
  onVideo: (id: string, time: number) => void;
  onDocument?: (id: string, page?: number) => void;
  onAskImage: (source: OcrResult['source']) => void;
}) {
  const [tab, setTab] = useState<'audio' | 'ocr' | 'search'|'video'>('audio'),
    [recognition, setRecognition] = useState<RecognitionState | null>(null),
    [language, setLanguage] = useState<'chinese' | 'english'>('chinese'),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [mode, setMode] = useState<SearchMode>('hybrid'),
    [hits, setHits] = useState<KnowledgeHit[]>([]),
    [backlinks, setBacklinks] = useState<Backlink[]>([]),
    [ocr, setOcr] = useState<OcrResult | null>(null);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const s = await api.recognition({ action: 'state' });
        if (live) setRecognition(s);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const index = state?.knowledge,
    cover = index?.chunks ? Math.round((index.embedded / index.chunks) * 100) : 0;
  return createPortal(
    <div className="modal-overlay learning-overlay" onClick={onClose}>
      <section
        className="learning-modal"
        role="dialog"
        aria-modal="true"
        aria-label="识别与全库检索"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <span className="learning-eyebrow">LOCAL LEARNING ENGINE</span>
            <h2>把声音、画面与笔记连起来</h2>
            <p>本地采音与检索保留来源；AI 看图时，原图按需交给你连接的视觉模型。</p>
          </div>
          <button aria-label="关闭识别面板" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <nav className="learning-tabs">
          {(
            [
              ['audio', AudioLines, '课程语音'],
              ['ocr', ScanText, '课件与板书'],
              ['search', Database, '全库检索'],
              ['video',Database,'视频缓存'],
            ] as const
          ).map(([key, Icon, label]) => (
            <button className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}>
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        {error && (
          <div className="learning-error" role="alert">
            {error}
          </div>
        )}
        <div className="learning-scroll">
          {tab==='video'&&<VideoCacheSettings/>}
          {tab === 'audio' && (
            <>
              <div className="learning-feature">
                <span className="learning-feature-icon">
                  <AudioLines size={30} />
                </span>
                <div>
                  <h3>听见没有字幕的讲解</h3>
                  <p>
                    只采集当前课程标签。原视频秒数会随倍速映射，跳转、暂停与切换课程会切分音轨，跨跳转的片段会丢弃并记为缺口。
                  </p>
                </div>
              </div>
              <div className="learning-card audio-controls">
                <div>
                  <b>
                    {recognition?.capturing
                      ? '正在聆听：' + recognition.sourceTitle
                      : state?.sources.find((s) => s.id === state.activeBinding?.sourceId)?.title ||
                        '先打开一段课程视频'}
                  </b>
                  <p>{recognition?.message}</p>
                </div>
                <label>
                  课程语言
                  <select
                    aria-label="转写语言"
                    value={language}
                    disabled={recognition?.capturing}
                    onChange={(e) => setLanguage(e.target.value as any)}
                  >
                    <option value="chinese">中文</option>
                    <option value="english">英语</option>
                  </select>
                </label>
                <button
                  className="learning-primary"
                  disabled={!!busy || (!recognition?.capturing && !state?.activeBinding)}
                  onClick={() =>
                    void run('采音', async () => {
                      const s = await api.recognition(
                        recognition?.capturing ? { action: 'stop' } : { action: 'start', language },
                      );
                      setRecognition(s);
                    })
                  }
                >
                  {recognition?.capturing ? <Square size={15} /> : <Mic size={15} />}{' '}
                  {recognition?.capturing ? '停止采音' : '开始课程采音'}
                </button>
              </div>
              <div className="learning-stats">
                <span>
                  <ShieldCheck size={14} /> 不使用麦克风 · 不录制其他软件声音
                </span>
                <span>
                  {recognition?.processing ? '正在转写' : recognition?.queued ? '等待处理' : '音轨待命'} ·
                  队列 {recognition?.queued || 0} · 对齐缺口 {recognition?.gaps || 0}
                </span>
              </div>
              <div className="learning-note">
                先开启采音，再正常播放课程。模型随包提供；首次加载和转写可能需要数秒。自动转写没有经过校准的置信分数，术语、倍速、噪声和音乐可能导致误识别，请点击时间核对原音。停止采音后会完成已排队的片段。
              </div>
              <div className="transcript-list">
                {recognition?.segments.length ? (
                  recognition.segments.map((segment) => (
                    <article key={segment.id}>
                      <button onClick={() => onVideo(segment.sourceId, segment.start)}>
                        <Play size={12} />
                        {time(segment.start)}–{time(segment.end)}
                      </button>
                      <div>
                        <p>{segment.text || '该段没有识别出可靠文字，请核对原音。'}</p>
                        <small title={segment.warning}>自动转写 · 需核对 · 时间存在采集延迟误差</small>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="learning-empty">
                    <AudioLines size={36} />
                    <b>讲解会在这里留下带时间的文字</b>
                    <p>目前没有转写，不代表课程中没有口头讲解。</p>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === 'ocr' && (
            <>
              <div className="learning-feature">
                <span className="learning-feature-icon">
                  <ScanText size={30} />
                </span>
                <div>
                  <h3>让 AI 看懂课件与板书</h3>
                  <p>模糊、复杂图像和公式以多模态模型查看原图为准。OCR 仅作可选参考，不要求先识别文字。</p>
                </div>
              </div>
              <div className="learning-grid">
                <button
                  className="learning-card learning-action"
                  disabled={!!busy}
                  onClick={() =>
                    void run('选择原图', async () => {
                      const report = await api.importImages();
                      if (report.errors.length) setError(report.errors.join('；'));
                      if (report.paths[0]) {
                        onAskImage({ kind: 'image', id: report.paths[0], vaultId: state?.vaultId });
                        onClose();
                      }
                    })
                  }
                >
                  <ImagePlus size={26} />
                  <b>选择图片交给 AI</b>
                  <span>准备原图路径，发送问题后由视觉模型按需读取</span>
                </button>
                <button
                  className="learning-card learning-action"
                  disabled={!state?.playback}
                  onClick={() => {
                    const p = state!.playback!;
                    onAskImage({ kind: 'video', id: p.sourceId, time: p.currentTime });
                    onClose();
                  }}
                >
                  <ScanText size={26} />
                  <b>让 AI 查看当前课程画面</b>
                  <span>按指定视频进度读取原始画面，无需先做 OCR</span>
                </button>
              </div>
              <details className="optional-ocr">
                <summary>可选：提取本地 OCR 参考文字</summary>
                <div className="learning-grid">
                  <button
                    className="learning-card learning-action"
                    disabled={!!busy}
                    onClick={() =>
                      void run('图片识别', async () => {
                        const report = await api.importImages();
                        if (report.errors.length) setError(report.errors.join('；'));
                        if (report.paths[0])
                          setOcr(await api.recognition({ action: 'ocr-image', path: report.paths[0] }));
                      })
                    }
                  >
                    <ImagePlus size={26} />
                    <b>导入图片并识别</b>
                    <span>复制到当前知识库附件，原文件保持不变</span>
                  </button>
                  <button
                    className="learning-card learning-action"
                    disabled={!!busy || !state?.playback}
                    onClick={() =>
                      void run('画面识别', async () => {
                        const playback = state!.playback!;
                        setOcr(
                          await api.recognition({
                            action: 'ocr-frame',
                            sourceId: playback.sourceId,
                            time: playback.currentTime,
                          }),
                        );
                      })
                    }
                  >
                    <ScanText size={26} />
                    <b>识别当前课程画面</b>
                    <span>读取当前进度的一帧，不改变前台播放</span>
                  </button>
                </div>
              </details>
              {(ocr || recognition?.ocr) && <OcrCard value={(ocr || recognition?.ocr)!} onAsk={onAskImage} />}
              <div className="learning-note">
                置信分数用于提示识别质量，不是事实正确率。数学公式、复杂表格和手写板书可能识别不准；AI
                会收到这些限制，仍可结合原图理解。
              </div>
            </>
          )}
          {tab === 'search' && (
            <>
              <div className="learning-feature">
                <span className="learning-feature-icon">
                  <Network size={30} />
                </span>
                <div>
                  <h3>全库索引，搜索含义与引用关系</h3>
                  <p>
                    后台扫描所有受支持的 Markdown，正文不再只查前500篇或64KB；全文、向量与链接关系保存在 D
                    盘，可增量更新。
                  </p>
                </div>
              </div>
              <div className="learning-card index-overview">
                <div>
                  <b>
                    {index?.phase === 'scanning'
                      ? '正在建立全文索引'
                      : index?.phase === 'error'
                        ? '索引需要检查'
                        : '全文索引可用'}
                  </b>
                  <p>{index?.message}</p>
                </div>
                <div className="index-numbers">
                  <span>
                    <b>{index?.files.toLocaleString() || 0}</b> 已索引笔记
                  </span>
                  <span>
                    <b>{index?.chunks.toLocaleString() || 0}</b> 正文片段
                  </span>
                  <span>
                    <b>{index?.skipped || 0}</b> 跳过文件
                  </span>
                </div>
                <div className="index-coverage">
                  <span>
                    语义覆盖 {cover}% · {index?.embedded || 0}/{index?.chunks || 0}
                  </span>
                  <progress value={index?.embedded || 0} max={index?.chunks || 1} />
                </div>
                <div className="learning-actions">
                  <button
                    disabled={!!busy}
                    onClick={() => void run('重建索引', () => api.knowledge({ action: 'rebuild' }))}
                  >
                    <RefreshCw size={14} /> 重新扫描
                  </button>
                  <button
                    className="learning-primary"
                    disabled={!!busy || !index?.chunks}
                    onClick={() =>
                      void run('语义索引', () =>
                        api.knowledge({ action: 'embed', enabled: !index?.embedding }),
                      )
                    }
                  >
                    {index?.embedding ? <Square size={14} /> : <Play size={14} />}{' '}
                    {index?.embedding ? '暂停语义索引' : cover >= 100 ? '检查语义更新' : '建立语义索引'}
                  </button>
                </div>
              </div>
              <form
                className="knowledge-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('检索', async () =>
                    setHits(await api.knowledge({ action: 'search', query, mode, limit: 30 })),
                  );
                }}
              >
                <Search size={18} />
                <input
                  aria-label="全库查询"
                  placeholder="输入关键词，或描述你想找的知识…"
                  value={query}
                  maxLength={200}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  aria-label="检索方式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as SearchMode)}
                >
                  <option value="hybrid">混合检索</option>
                  <option value="keyword">全文关键词</option>
                  <option value="semantic">语义检索</option>
                </select>
                <button className="learning-primary" disabled={!!busy || !query.trim()}>
                  搜索
                </button>
              </form>
              <div className="knowledge-results">
                {hits.map((hit) => (
                  <button
                    key={hit.path}
                    onClick={() => {
                      onOpenNote(hit.path);
                      onClose();
                    }}
                  >
                    <span>
                      <b>{hit.name}</b>
                      <em>
                        {hit.match === 'both'
                          ? '全文 + 语义'
                          : hit.match === 'semantic'
                            ? '语义相关'
                            : '全文命中'}
                      </em>
                    </span>
                    <small>
                      {hit.path} · 第{hit.lineStart}–{hit.lineEnd}行
                    </small>
                    <p>{hit.snippet}</p>
                  </button>
                ))}
              </div>
              <div className="learning-card backlink-card">
                <div>
                  <h4>
                    <Network size={17} /> 当前笔记的反向链接
                  </h4>
                  <p>{note || '先打开一篇笔记'}</p>
                </div>
                <button
                  disabled={!note || !!busy}
                  onClick={() =>
                    void run('反向链接', async () =>
                      setBacklinks(await api.knowledge({ action: 'backlinks', path: note! })),
                    )
                  }
                >
                  查找引用
                </button>
                {backlinks.map((link, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      onOpenNote(link.path);
                      onClose();
                    }}
                  >
                    <b>{link.name}</b>
                    <small>
                      {link.path} · 第{link.line}行 · {link.target}
                    </small>
                  </button>
                ))}
              </div>
              <div className="learning-note">
                语义模型随包提供，建立向量索引会占用
                CPU，可随时暂停；未完成时仍可全文检索，混合结果会注明语义覆盖。单笔记超过2MiB或非UTF-8会被跳过；不跟随目录联接，不扫描
                .obsidian 等配置目录。左侧目录暂显示前5000篇，搜索覆盖后台已索引的全部笔记。
              </div>
            </>
          )}
        </div>
        <footer>
          <span>
            <ShieldCheck size={14} /> 本地采音、OCR 与检索无需密钥；AI 看图需连接视觉模型
          </span>
          {busy && (
            <span>
              <LoaderCircle size={14} className="spin" />
              {busy}中…
            </span>
          )}
          <button onClick={onClose}>返回学习</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
export function OcrCard({
  value,
  onAsk,
}: {
  value: OcrResult;
  onAsk?: (source: OcrResult['source']) => void;
}) {
  return (
    <section className={'ocr-result learning-card ' + (value.lowConfidence ? 'low-confidence' : '')}>
      <header>
        <b>OCR 参考文字</b>
        <span>
          {value.lowConfidence ? '低置信 · 请核对' : '识别置信'} {Math.round(value.confidence)} / 100
        </span>
      </header>
      {onAsk && (
        <button className="learning-primary" onClick={() => onAsk(value.source)}>
          让 AI 看原图
        </button>
      )}
      <pre>{value.text || '未识别出可靠文字，请查看原图或尝试框选较清晰区域。'}</pre>
      <small>
        {value.source.kind === 'document'
          ? `来源：文档第 ${value.source.page} 页`
          : value.source.kind === 'video'
            ? `来源：视频 ${time(value.source.time || 0)}`
            : '来源：' + value.source.id}
        {value.source.region ? ' · 指定选区' : ''}
      </small>
      {value.warnings.map((warning, i) => (
        <p className="ocr-warning" key={i}>
          {warning}
        </p>
      ))}
    </section>
  );
}
