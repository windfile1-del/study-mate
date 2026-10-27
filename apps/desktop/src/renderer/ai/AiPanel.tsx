import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogIn,
  MessageCircle,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
  ImagePlus,
  RefreshCw,
} from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { parseDocumentCitation, type DocumentContext } from '../../shared/documents';
import {parseVideoCitation} from '../../shared/recognition';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  AI_PRESETS,
  defaultAiConfig,
  type AiConfig,
  type AiRequest,
  type AiState,
  type AiUsage,
} from '../../shared/ai';
import './ai.css';
import './tools.css';
import { remarkReadableMath } from '../notes/readable-math';
import { normalizeDisplayMath } from '../notes/math-source';
const number = (n: number | null | undefined) => (n == null ? '未返回' : n.toLocaleString());
const toolLabels: Record<string, string> = {
  search_knowledge:'全文与语义检索',get_backlinks:'查询反向链接',read_transcript:'读取课程转写',ocr_document_page:'识别扫描页或板书',ocr_image:'识别图片文字',
  list_notes: '浏览笔记目录',
  search_notes: '搜索笔记',
  read_note: '按行读取笔记',
  save_note: '保存笔记',
  replace_in_note: '精确替换并保存',
  list_images: '查找图片',
  view_image: '查看图片',
  insert_image: '插入图片并保存',
  get_video_context: '读取视频上下文',
  analyze_video: '抽帧分析视频',
  read_video_frames:'读取后台缓存画面',read_video_subtitles:'按时间读取字幕',search_video_subtitles:'搜索字幕定位片段',watch_video:'后台观看原视频片段',
  list_documents: '浏览已打开文档',
  search_document: '搜索文档页',
  read_document_page: '读取页面文字与备注',
  view_document_page: '查看页面图像',
};
const effortLabels: Record<string, string> = {
  auto: '由模型决定',
  none: '关闭推理',
  minimal: '极轻',
  low: '轻量',
  medium: '均衡',
  high: '深入',
  xhigh: '更深入',
  max: '最高',
};
export function AiPanel({
  documentContext,
  onOpenDocument,
  onOpenVideo,
  externalPrompt,
  note,
  vaultId,
  courseAvailable,
  onSettings,
  onConversation,
  dirtyPaths,
  onNoteChange,
  onOpenNote,
}: {
  documentContext?: DocumentContext;
  onOpenDocument: (id: string, page: number) => void;
  onOpenVideo:(id:string,time:number)=>void;
  externalPrompt?:{id:string;text:string;image?:{vaultId:string;path:string}};
  note: string | null;
  vaultId: string;
  courseAvailable: boolean;
  onSettings: (open: boolean) => void;
  onConversation: (active: boolean) => void;
  dirtyPaths: string[];
  onNoteChange: (path: string) => void;
  onOpenNote: (path: string) => void;
}) {
  const [state, setState] = useState<AiState | null>(null),
    [error, setError] = useState(''),
    [settings, setSettings] = useState(false),
    [text, setText] = useState('');
  const [attachNote, setAttachNote] = useState(false),
    [attachCourse, setAttachCourse] = useState(true),
    [pending, setPending] = useState(false),
    [stats, setStats] = useState(false);
  const [selectedImage,setSelectedImage]=useState<{vaultId:string;path:string}>();
  const appliedPrompt=useRef('');
  useEffect(()=>{if(externalPrompt&&appliedPrompt.current!==externalPrompt.id){appliedPrompt.current=externalPrompt.id;setSelectedImage(externalPrompt.image);setText(prev=>prev.trim()?prev+'\n\n'+externalPrompt.text:externalPrompt.text);}},[externalPrompt]);
  const [allowWrite, setAllowWrite] = useState(false);
  const [attachDocument, setAttachDocument] = useState(true);
  const [manualModel, setManualModel] = useState(false),
    [modelId, setModelId] = useState('');
  const refreshedTools = useRef(new Set<string>());
  useEffect(() => {
    for (const message of state?.messages || [])
      for (const tool of message.tools || []) {
        const key = message.id + ':' + tool.id;
        if (tool.changed && tool.status === 'complete' && !refreshedTools.current.has(key)) {
          refreshedTools.current.add(key);
          onNoteChange(tool.changed);
        }
      }
  }, [state?.messages, onNoteChange]);
  const log = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let last = '';
    const poll = async () => {
      try {
        const s = await window.studyMate.ai({ action: 'state' });
        const signature = JSON.stringify(s);
        if (alive.current && signature !== last) {
          last = signature;
          setState(s);
        }
      } catch (e) {
        if (alive.current) setError(String(e));
      } finally {
        if (alive.current) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [state?.messages]);
  useEffect(() => onConversation(!!state?.messages.length), [!!state?.messages.length, onConversation]);
  const run = async (req: AiRequest) => {
    setError('');
    try {
      const next = await window.studyMate.ai(req);
      setState(next);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      return null;
    }
  };
  const showSettings = (open: boolean) => {
    setSettings(open);
    onSettings(open);
  };
  const send = async () => {
    if (!text.trim() || pending || state?.busy) return;
    setPending(true);
    follow.current = true;
    const next = await run({
      action: 'send',
      image:selectedImage,
      document: attachDocument ? documentContext : undefined,
      text: text.trim(),
      note: attachNote && note ? { path: note, vaultId } : undefined,
      course: attachCourse && courseAvailable,
      allowWrite,
      dirtyPaths,
    });
    if (next){setText('');setSelectedImage(undefined);}
    setPending(false);
  };
  const latest = state?.messages.filter((m) => m.role === 'assistant').at(-1),
    usage = latest?.usage;
  const estimate = state?.contextEstimate || 0,
    capacity = state?.config.contextSize || 32768,
    actual = latest?.lastInput ?? usage?.input,
    used = actual ?? estimate,
    pct = Math.min(100, Math.round((used / capacity) * 100));
  const connected = ['siwc', 'antigravity'].includes(state?.config.protocol || '')
    ? !!state?.account?.authorized
    : !!state?.hasKey || state?.config.preset === 'custom';
  return (
    <section className="ai-panel">
      <header className="ai-heading">
        <span className="ai-brand">
          <Sparkles size={17} />
          伴学助手
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="新建 AI 对话"
            title="归档当前对话并开始新的对话"
            disabled={state?.busy}
            onClick={() => void run({ action: 'clear' })}
          >
            <Plus size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="AI 接入设置"
            title="模型与接入设置"
            onClick={() => showSettings(true)}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>
      <button className="ai-model-picker" onClick={() => showSettings(true)}>
        <span className={connected ? 'connected-dot' : 'idle-dot'} />
        <span>
          {state?.config.model || '选择你的 AI 模型'}
          <small>
            {AI_PRESETS.find((p) => p.id === state?.config.preset)?.name || '接入设置'} ·{' '}
            {effortLabels[state?.config.effort || 'auto']}
          </small>
        </span>
        <ChevronRight size={14} />
      </button>
      {state && (
        <div className="ai-quick-controls">
          <label>
            服务
            <select
              aria-label="对话服务商"
              value={state.config.preset}
              disabled={!!state.login}
              onChange={(e) => void run({ action: 'select', preset: e.target.value })}
            >
              {[...new Set([state.config.preset, ...Object.keys(state.profiles)])].map((id) => (
                <option key={id} value={id}>
                  {AI_PRESETS.find((p) => p.id === id)?.name || id}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="ai-model-field-label">
              模型
              <button
                aria-label="手动输入对话模型"
                title="服务不返回模型列表时，可输入模型 ID"
                disabled={!!state.login}
                onClick={(e) => {
                  e.preventDefault();
                  setModelId(state.config.model);
                  setManualModel(!manualModel);
                }}
              >
                ID
              </button>
            </span>
            <select
              aria-label="对话模型"
              value={state.config.model}
              disabled={!!state.login}
              onChange={(e) => {
                if (e.target.value) void run({ action: 'select', model: e.target.value });
              }}
            >
              {!state.config.model && <option value="">先获取模型列表</option>}
              {[
                ...new Map(
                  [{ id: state.config.model, displayName: state.config.model }, ...state.models]
                    .filter((m) => m.id)
                    .map((m) => [m.id, m]),
                ).values(),
              ].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName || m.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            推理
            <select
              aria-label="对话推理强度"
              value={state.config.effort}
              disabled={!!state.login}
              onChange={(e) => void run({ action: 'select', effort: e.target.value as AiConfig['effort'] })}
            >
              {[
                ...new Set([
                  'auto',
                  ...(state.models.find((m) => m.id === state.config.model)?.efforts.length
                    ? state.models.find((m) => m.id === state.config.model)!.efforts
                    : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
                  state.config.effort,
                ]),
              ].map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabels[effort] || effort}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ai-quick-refresh"
            aria-label="刷新对话模型列表"
            title="读取当前服务可用模型"
            disabled={!!state.login}
            onClick={() => void run({ action: 'models' })}
          >
            <RefreshCw size={13} />
          </button>
          {manualModel && (
            <form
              className="ai-manual-model"
              onSubmit={(e) => {
                e.preventDefault();
                if (modelId.trim())
                  void run({ action: 'select', model: modelId.trim() }).then((next) => {
                    if (next) setManualModel(false);
                  });
              }}
            >
              <input
                aria-label="输入对话模型ID"
                value={modelId}
                maxLength={200}
                placeholder="填写服务提供的模型 ID，Enter 生效"
                onChange={(e) => setModelId(e.target.value)}
              />
              <button type="submit" disabled={!modelId.trim()}>
                使用
              </button>
            </form>
          )}
          <small>
            {state.busy ? '切换将在下次提问生效，当前回答继续。' : '直接选择即可生效，无需打开接入设置。'}
          </small>
        </div>
      )}
      <div
        className="ai-messages"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
        }}
        aria-label="AI 对话记录"
      >
        {!state?.messages.length && (
          <div className="ai-welcome">
            <div className="ai-welcome-mark">
              <MessageCircle size={25} />
            </div>
            <h3>把问题留在学习现场</h3>
            <p>
              理解一个公式，梳理一段课程，
              <br />
              或者一起找出笔记里的关键线索。
            </p>
            <button className="ai-connect" onClick={() => showSettings(true)}>
              {connected ? '调整模型与参数' : '连接你的第一个模型'}
              <ChevronRight size={14} />
            </button>
            <div className="ai-privacy">
              <ShieldCheck size={13} />
              AI 按需调用学习工具。笔记先附路径，实际读取的片段与视频抽帧才会发给所选模型。
            </div>
          </div>
        )}
        {state?.messages.slice(-60).map((m) => (
          <article key={m.id} className={'ai-message ' + m.role}>
            <div className="ai-message-label">
              {m.role === 'user' ? '你' : m.model || '伴学助手'}
              {m.status === 'streaming' && <LoaderCircle size={12} className="spin" />}
              {m.role === 'assistant' && m.text && (
                <button
                  className="icon-button"
                  aria-label="复制回答"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(m.text)
                      .catch(() => setError('复制失败，请手动选择文本。'))
                  }
                >
                  <Copy size={12} />
                </button>
              )}
            </div>
            {m.attachment && <div className="ai-attachment">附加：{m.attachment}</div>}
            {!!m.tools?.length && (
              <details className="ai-tool-log" open={m.status === 'streaming' || undefined}>
                <summary>
                  <Sparkles size={13} /> 学习工具 · {m.tools.length} 次调用{' '}
                  {m.tools.some((t) => t.status === 'running') ? '· 执行中' : ''}
                </summary>
                {m.tools.map((tool, i) => (
                  <div className={'ai-tool-item ' + tool.status} key={tool.id + i}>
                    <span className="ai-tool-status">
                      {tool.status === 'running' ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : tool.status === 'complete' ? (
                        <Check size={13} />
                      ) : (
                        <X size={13} />
                      )}
                    </span>
                    <div>
                      <strong>{toolLabels[tool.name] || tool.name}</strong>
                      <span>{tool.target}</span>
                      <p>{tool.summary}</p>
                      {tool.changed && (
                        <button className="ai-tool-open" onClick={() => onOpenNote(tool.changed!)}>
                          打开笔记
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </details>
            )}
            <div className="ai-message-content">
              {m.status === 'streaming' ? (
                <span className="ai-stream-text">{m.text || '正在思考…'}</span>
              ) : (
                <ReactMarkdown
                  urlTransform={(url) => (parseDocumentCitation(url)||parseVideoCitation(url) ? url : defaultUrlTransform(url))}
                  remarkPlugins={[remarkGfm, remarkMath, remarkReadableMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={{
                    a: ({ children, href }) => {
                      const cite = parseDocumentCitation(href || '');
                      const video=parseVideoCitation(href||'');
                      if(video)return <button className="citation-link" onClick={()=>onOpenVideo(video.id,video.time)}>{children} ↗</button>;
                      return cite ? (
                        <button className="citation-link" onClick={() => onOpenDocument(cite.id, cite.page)}>
                          {children} ↗
                        </button>
                      ) : (
                        <span>{children}</span>
                      );
                    },
                    img: () => null,
                  }}
                >
                  {normalizeDisplayMath(m.text)}
                </ReactMarkdown>
              )}
            </div>
            {m.error && <p className="ai-inline-error">{m.error}</p>}
            {m.usage && (
              <small className="ai-turn-usage">
                输入 {number(m.usage.input)} · 输出 {number(m.usage.output)} · 缓存 {number(m.usage.cached)}{' '}
                tokens {m.requests ? ` · ${m.requests} 次模型请求` : ''}
              </small>
            )}
          </article>
        ))}
      </div>
      {error && (
        <div className="ai-error" role="alert">
          {error}
          <button aria-label="关闭 AI 错误" onClick={() => setError('')}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="ai-meter">
        <button onClick={() => setStats(!stats)} aria-expanded={stats}>
          <span className="ai-meter-bar">
            <i style={{ width: pct + '%' }} />
          </span>
          <span>
            上下文 {actual == null ? '≈' : ''}
            {pct}%
          </span>
          <SlidersHorizontal size={12} />
        </button>
        <small>本轮 {number(usage?.total)} tokens</small>
      </div>
      {stats && (
        <div className="ai-usage-detail">
          <div>
            <span>请求上下文（本地估算）</span>
            <strong>
              ≈{number(estimate)} / {number(capacity)}
            </strong>
          </div>
          <div>
            <span>输入 / 输出（服务商返回）</span>
            <strong>
              {number(usage?.input)} / {number(usage?.output)}
            </strong>
          </div>
          <div>
            <span>缓存命中 / 写入</span>
            <strong>
              {number(usage?.cached)} / {number(usage?.cacheWrite)}
            </strong>
          </div>
          <div>
            <span>本轮加权缓存命中率</span>
            <strong>
              {usage?.input && usage.cached != null
                ? ((100 * usage.cached) / usage.input).toFixed(1) + '%'
                : '未返回'}
            </strong>
          </div>
          <p>
            统计包含本轮工具循环的全部模型请求。首轮预热、较短提示、切换模型、压缩历史或服务商缓存过期可能降低命中，稳定前缀不能保证固定命中率。
          </p>
          <div>
            <span>推理 tokens</span>
            <strong>{number(usage?.reasoning)}</strong>
          </div>
          <div>
            <span>本轮费用</span>
            <strong>
              {['siwc', 'antigravity'].includes(state?.config.protocol || '')
                ? '套餐额度'
                : usage?.cost == null
                  ? '未知（未配置单价或数据不全）'
                  : '≈ $' + usage.cost.toFixed(6)}
            </strong>
          </div>
          <p>
            占用率优先使用服务商返回的本轮用量；没有返回时使用本地估算。缓存以返回数据为准；费用按手填美元单价估算，不含税费。
            {state?.omitted ? ' 已跳过 ' + state.omitted + ' 组较早消息，以控制上下文。' : ''}
          </p>
        </div>
      )}
      {state?.notice && (
        <div className="ai-notice" role="status">
          {state.notice}
        </div>
      )}
      <div className="ai-compression-tools">
        <button
          aria-label="压缩上下文"
          disabled={
            !!state?.busy ||
            !state?.config.model ||
            (state?.messages.length || 0) - (state?.memory?.covered || 0) < 8
          }
          title="使用当前模型生成历史摘要，会计入服务商用量；原消息不删除"
          onClick={() => void run({ action: 'compact' })}
        >
          {state?.compacting ? <LoaderCircle size={12} className="spin" /> : <SlidersHorizontal size={12} />}
          压缩上下文
        </button>
        <span>
          {state?.compacting
            ? '正在生成摘要…'
            : state?.memory
              ? `≈${state.memory.before.toLocaleString()} → ${state.memory.after.toLocaleString()} tokens`
              : '保留最近三轮'}
        </span>
      </div>
      {state?.memory && (
        <details className="ai-context-memory">
          <summary>查看较早对话摘要 · 原消息仍保留</summary>
          <pre>{state.memory.summary}</pre>
          <small>
            模型：{state.memory.model} · 压缩用量 {number(state.memory.usage?.total)} tokens
          </small>
        </details>
      )}
      <div className="ai-composer">
        <p className="ai-path-hint">
          笔记先附路径 · 正文与视频画面按需读取 · {allowWrite ? '可保存，自动备份' : '只读模式'}
        </p>
        <div className="ai-context-options">
          <button
            className="ai-image-import"
            disabled={state?.busy}
            title="选择本地图片复制到知识库，原图不修改；发送时先给路径"
            aria-label="导入图片到知识库"
            onClick={() => {
              void window.studyMate
                .importImages()
                .then((report) => {
                  if (report.paths.length)
                    setText(
                      (old) => old + (old ? '\n' : '') + '使用这些知识库图片：\n' + report.paths.join('\n'),
                    );
                  if (report.errors.length) setError(report.errors.join('；'));
                })
                .catch((e) => setError(e instanceof Error ? e.message : '图片导入失败'));
            }}
          >
            <ImagePlus size={13} />
            图片
          </button>
          {documentContext && (
            <label title="仅附文档编号、页码与主动选区；AI 按需调用工具读取，不发送整份文件。">
              <input
                type="checkbox"
                checked={attachDocument}
                onChange={(e) => setAttachDocument(e.target.checked)}
              />
              文档 · 第{documentContext.page}页{documentContext.selection ? ' · 选区' : ''}
            </label>
          )}
          <label title={note ? note + ' · 先附路径，AI 可按需读取所需行' : '先打开笔记'}>
            <input
              type="checkbox"
              checked={attachNote}
              disabled={!note}
              onChange={(e) => setAttachNote(e.target.checked)}
            />
            笔记路径
          </label>
          <label title="开启后，AI 可按你的要求创建、替换、保存笔记或插图；原文自动备份，未保存草稿受保护。">
            <input
              type="checkbox"
              checked={allowWrite}
              disabled={state?.busy}
              onChange={(e) => setAllowWrite(e.target.checked)}
            />
            允许保存
          </label>
          <label title="发送时冻结课程和进度，模型按需自动读取字幕、缓存画面，或在后台观看原视频片段">
            <input
              type="checkbox"
              checked={attachCourse}
              disabled={!courseAvailable}
              onChange={(e) => setAttachCourse(e.target.checked)}
            />
            自动看课
          </label>
        </div>
        {selectedImage&&<div className="ai-image-reference"><span>待查看原图：{selectedImage.path}</span><button aria-label="移除原图引用" onClick={()=>setSelectedImage(undefined)}>×</button></div>}
        <textarea
          aria-label="伴学提问"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={connected ? '哪里还不理解？Shift + Enter 换行' : '先连接模型，再开始你的第一问…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="ai-send-row">
          <small>{state?.busy ? '正在回答 · 可随时停止' : 'Enter 发送 · 资料按次附加'}</small>
          {state?.busy ? (
            <button
              className="ai-send"
              aria-label="停止 AI 生成"
              onClick={() => void run({ action: 'cancel' })}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="ai-send"
              aria-label="发送 AI 消息"
              disabled={!text.trim() || pending}
              onClick={() => void send()}
            >
              {pending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}
            </button>
          )}
        </div>
      </div>
      {settings &&
        state &&
        createPortal(
          <AiSettings state={state} run={run} onClose={() => showSettings(false)} error={error} />,
          document.body,
        )}
    </section>
  );
}
function AiSettings({
  state,
  run,
  onClose,
  error,
}: {
  state: AiState;
  run: (r: AiRequest) => Promise<AiState | null>;
  onClose: () => void;
  error: string;
}) {
  const [form, setForm] = useState<AiConfig>({ ...state.config }),
    [key, setKey] = useState(''),
    [working, setWorking] = useState(false),
    [success, setSuccess] = useState('');
  const preset = AI_PRESETS.find((p) => p.id === form.preset) || AI_PRESETS[0],
    subscription = ['siwc', 'antigravity'].includes(form.protocol),
    account = form.protocol === state.config.protocol ? state.account : null,
    accounts = form.protocol === state.config.protocol ? state.accounts : [];
  const change = (p: Partial<AiConfig>) => {
    setForm((f) => ({ ...f, ...p }));
    setSuccess('');
  };
  const selectPreset = (id: string) => {
    const p = AI_PRESETS.find((p) => p.id === id)!;
    setForm(
      state.profiles[id] || {
        ...defaultAiConfig,
        preset: id,
        protocol: p.protocol,
        baseUrl: p.url,
        model: p.model,
      },
    );
    setKey('');
    setSuccess('');
  };
  const save = async () => {
    const next = await run({ action: 'configure', config: form, key: key || undefined });
    if (next) {
      setKey('');
      setSuccess('已保存。可以发送一个简短问题验证连接。');
    }
    return next;
  };
  const action = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };
  const available = state.config.preset === form.preset ? state.models : [];
  const model = available.find((m) => m.id === form.model);
  const efforts = model?.efforts.length
    ? ['auto', ...model.efforts]
    : form.protocol === 'anthropic'
      ? ['auto', 'low', 'medium', 'high', 'max']
      : form.protocol === 'gemini'
        ? ['auto', 'minimal', 'low', 'medium', 'high']
        : ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return (
    <div className="modal-overlay ai-settings-overlay">
      <section className="ai-settings" role="dialog" aria-modal="true" aria-label="模型接入与设置">
        <header>
          <div>
            <span className="ai-eyebrow">YOUR LEARNING, YOUR MODEL</span>
            <h2>连接适合你的 AI</h2>
            <p>选择服务，完成授权，再把理解往前推进一步。</p>
          </div>
          <button className="icon-button" aria-label="关闭模型设置" onClick={onClose}>
            <X size={21} />
          </button>
        </header>
        <div className="ai-settings-body">
          <nav aria-label="模型服务商">
            <small>接入方式</small>
            {AI_PRESETS.map((p) => (
              <button
                key={p.id}
                className={p.id === form.preset ? 'selected' : ''}
                onClick={() => selectPreset(p.id)}
              >
                <span>
                  {['siwc', 'antigravity'].includes(p.id) ? <LogIn size={16} /> : <KeyRound size={16} />}
                </span>
                <div>
                  {p.name}
                  <small>
                    {['siwc', 'antigravity'].includes(p.protocol)
                      ? p.protocol === 'siwc'
                        ? '官方 SIWC 授权'
                        : '实验兼容 · 有账户风险'
                      : p.id === 'custom'
                        ? '自托管或兼容服务'
                        : 'API 密钥 · 按平台计费'}
                  </small>
                </div>
                {p.id === form.preset && <Check size={14} />}
              </button>
            ))}
            <div className="ai-guide-note">
              <ShieldCheck size={17} />
              <p>
                凭据在本地由 Windows 加密保存。SIWC 以 Study Mate 名称授权，不读取 Codex 登录。Antigravity
                为非官方实验兼容接入。
              </p>
            </div>
          </nav>
          <div className="ai-settings-form">
            <div className="ai-provider-title">
              <span className="ai-step">01</span>
              <div>
                <h3>{preset.name}</h3>
                <p>{preset.help}</p>
              </div>
            </div>
            {subscription ? (
              <div className="ai-login-card">
                <strong>
                  {account?.authorized
                    ? '已授权使用订阅'
                    : account
                      ? '账号已验证，尚未授权套餐'
                      : '连接你的订阅账号'}
                </strong>
                <p>
                  {form.protocol === 'siwc'
                    ? '授权页面应显示 Study Mate。使用官方 SIWC 独立注册及套餐授权，不启动或登录 Codex。'
                    : '参考 Harness-Mate 的 Google OAuth 兼容方式；非官方接入，可能导致相关账户停用，订阅不保证可用。'}
                </p>
                {accounts.length > 0 && (
                  <label>
                    当前账户
                    <select
                      aria-label="订阅账户"
                      value={account?.id || ''}
                      disabled={working || state.busy || !!state.login}
                      onChange={(e) =>
                        void action(() => run({ action: 'selectAccount', id: e.target.value }))
                      }
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                          {a.authorized ? '' : ' · 未授权/已退出'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="ai-login-actions">
                  <button
                    className="primary"
                    disabled={working || !!state.login || state.busy}
                    onClick={() =>
                      void action(async () => {
                        if (await save()) await run({ action: 'login' });
                      })
                    }
                  >
                    <LogIn size={15} />
                    {form.protocol === 'siwc' ? 'Continue with ChatGPT' : '使用 Google 账号登录'}
                  </button>
                  <button
                    disabled={working || !!state.login || state.busy}
                    onClick={() =>
                      void action(async () => {
                        if (await save()) await run({ action: 'login', newAccount: true });
                      })
                    }
                  >
                    添加账户
                  </button>
                  {account && (
                    <button
                      disabled={working || state.busy}
                      onClick={() => void action(() => run({ action: 'logout' }))}
                    >
                      退出登录
                    </button>
                  )}
                </div>
                {state.login && (
                  <div className="ai-login-pending">
                    <strong>等待官方浏览器授权</strong>
                    <p>完成后自动更新；如浏览器未打开，可复制下方链接。</p>
                    <input readOnly aria-label="官方授权地址" value={state.login.url} />
                    <button onClick={() => void run({ action: 'cancelLogin' })}>取消本次登录</button>
                  </div>
                )}
                {form.protocol === 'siwc' && (
                  <button
                    className="ai-portal"
                    onClick={() => void run({ action: 'link', url: 'https://chatgpt.com/settings/usage' })}
                  >
                    查看 ChatGPT 用量与应用授权
                    <ExternalLink size={13} />
                  </button>
                )}
                <small>
                  不会自动转用 API 余额。旧版 Codex
                  凭据不会迁移。仅登录成功不代表已授权套餐，实际权限以授权范围和推理响应为准。
                </small>
              </div>
            ) : (
              <div className="ai-key-card">
                <div className="ai-howto">
                  <span>1. 打开服务商平台并登录</span>
                  <span>2. 创建 API Key，确认额度</span>
                  <span>3. 粘贴密钥并保存</span>
                </div>
                {preset.portal && (
                  <button
                    className="ai-portal"
                    onClick={() => void run({ action: 'link', url: preset.portal })}
                  >
                    打开 {preset.name} 密钥管理
                    <ExternalLink size={13} />
                  </button>
                )}
                <label>
                  API Key{' '}
                  <small>
                    {state.config.preset === form.preset && state.hasKey
                      ? '已安全保存；留空保留原密钥'
                      : '本地免密接口可留空'}
                  </small>
                  <input
                    aria-label="API Key"
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setSuccess('');
                    }}
                    placeholder="粘贴服务商提供的密钥，内容不会回显"
                  />
                </label>
                {state.config.preset === form.preset && state.hasKey && (
                  <button
                    className="ai-forget"
                    onClick={() =>
                      void action(() => run({ action: 'configure', config: form, forgetKey: true }))
                    }
                  >
                    移除此服务已保存的密钥
                  </button>
                )}
              </div>
            )}
            <div className="ai-provider-title">
              <span className="ai-step">02</span>
              <div>
                <h3>选择模型与思考方式</h3>
                <p>模型 ID 是服务商提供的调用名称，不是网页产品名称。</p>
              </div>
            </div>
            <div className="ai-field-row model-row">
              <label>
                模型 ID
                <input
                  aria-label="AI 模型 ID"
                  list="ai-model-catalog"
                  value={form.model}
                  onChange={(e) => {
                    const found = available.find((m) => m.id === e.target.value);
                    change({
                      model: e.target.value,
                      effort: 'auto',
                      ...(found?.contextSize ? { contextSize: Math.min(2_000_000, found.contextSize) } : {}),
                    });
                  }}
                  placeholder="先获取模型列表，或填写准确的模型 ID"
                />
                <datalist id="ai-model-catalog">
                  {available.map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </label>
              <button
                disabled={working || state.busy}
                onClick={() =>
                  void action(async () => {
                    if (await save()) {
                      const next = await run({ action: 'models' });
                      if (next?.models.length && !form.model) {
                        change({ model: next.models[0].id });
                        setSuccess('已获取模型。请选择后保存设置；列表不代表模型访问已验证。');
                      }
                    }
                  })
                }
              >
                {working ? <LoaderCircle size={14} className="spin" /> : null}获取模型列表
              </button>
            </div>
            {!!available.length && (
              <select
                className="ai-catalog-select"
                aria-label="已获取的模型"
                value={available.some((m) => m.id === form.model) ? form.model : ''}
                onChange={(e) => change({ model: e.target.value, effort: 'auto' })}
              >
                <option value="">从 {available.length} 个模型中选择</option>
                {available.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            )}
            <div className="ai-field-row">
              <label>
                推理程度
                <select
                  aria-label="AI 推理程度"
                  value={form.effort}
                  onChange={(e) => change({ effort: e.target.value as AiConfig['effort'] })}
                >
                  {efforts.map((v) => (
                    <option key={v} value={v}>
                      {effortLabels[v] || v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                上下文大小（tokens）
                <input
                  aria-label="AI 上下文大小"
                  type="number"
                  min={4096}
                  max={2000000}
                  step={1024}
                  value={form.contextSize}
                  onChange={(e) => change({ contextSize: Number(e.target.value) })}
                />
              </label>
              <label>
                输出上限（tokens）
                <input
                  aria-label="AI 输出上限"
                  type="number"
                  min={256}
                  max={64000}
                  step={256}
                  value={form.maxOutput}
                  onChange={(e) => change({ maxOutput: Number(e.target.value) })}
                />
              </label>
            </div>
            <p className="ai-field-hint">
              上下文是模型一次能参考的内容预算，包含历史、引用路径和回答。填写值不能扩大模型本身上限。推理选项需模型支持，不确定时选「由模型决定」。
            </p>
            <section className="ai-compression-settings">
              <label>
                <input
                  type="checkbox"
                  aria-label="自动压缩上下文"
                  checked={form.autoCompact}
                  onChange={(e) => change({ autoCompact: e.target.checked })}
                />
                接近上下文上限时自动压缩
              </label>
              <label>
                压缩触发比例
                <select
                  aria-label="压缩触发比例"
                  value={form.compactAt}
                  onChange={(e) => change({ compactAt: Number(e.target.value) })}
                >
                  {[0.5, 0.6, 0.7, 0.8, 0.9].map((n) => (
                    <option key={n} value={n}>
                      {n * 100}%
                    </option>
                  ))}
                </select>
              </label>
              <p>
                使用当前模型将较早消息整理为摘要，保留最近三轮。摘要可查看，原消息不删除；失败不替换原上下文。压缩请求会使用服务商额度，不等于缓存命中。笔记只附加路径，本轮没有本地文件读取或修改工具。
              </p>
            </section>
            {!subscription && (
              <details className="ai-advanced">
                <summary>高级设置 · 接口与费用估算</summary>
                <label>
                  接口协议
                  <select
                    aria-label="AI 接口协议"
                    value={form.protocol}
                    onChange={(e) => change({ protocol: e.target.value as AiConfig['protocol'] })}
                  >
                    <option value="chat">OpenAI Chat Completions 兼容</option>
                    <option value="responses">OpenAI Responses</option>
                    <option value="anthropic">Anthropic Messages</option>
                    <option value="gemini">Google Gemini</option>
                  </select>
                </label>
                <label>
                  API 基础地址
                  <input
                    aria-label="AI API 基础地址"
                    value={form.baseUrl}
                    onChange={(e) => change({ baseUrl: e.target.value })}
                  />
                </label>
                <p>
                  填写到版本路径即可，例如 https://api.openai.com/v1；不要加 /responses 或
                  /chat/completions。修改地址后请确认密钥应交给该服务。
                </p>
                <div className="ai-field-row">
                  {(
                    [
                      ['inputPrice', '输入单价'],
                      ['cachedPrice', '缓存读取单价'],
                      ['outputPrice', '输出单价'],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k}>
                      {label}
                      <input
                        aria-label={label}
                        type="number"
                        min={0}
                        step="any"
                        placeholder="未知则留空"
                        value={form[k] ?? ''}
                        onChange={(e) =>
                          change({ [k]: e.target.value === '' ? null : Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p>
                  单位：美元 / 百万 tokens。以服务商当前模型报价手动填写；缺少用量或缓存写入价格时不估算金额。
                </p>
              </details>
            )}
            {error && (
              <div className="ai-error" role="alert">
                {error}
              </div>
            )}
            {success && (
              <div className="ai-success">
                <Check size={14} />
                {success}
              </div>
            )}
            {state.notice && <p className="ai-state-notice">{state.notice}</p>}
          </div>
        </div>
        <footer>
          <span>
            <ShieldCheck size={14} />
            资料只在你发送问题时按勾选范围发送
          </span>
          <div>
            <button onClick={onClose}>返回学习</button>
            <button className="primary" disabled={working || state.busy} onClick={() => void action(save)}>
              {working ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存接入设置
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
