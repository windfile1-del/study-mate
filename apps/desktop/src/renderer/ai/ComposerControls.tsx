import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { AI_PRESETS, type AiConfig, type AiRequest, type AiState } from '../../shared/ai';
const labels: Record<string, string> = {
  auto: '自动',
  none: '关闭',
  minimal: '极轻',
  low: '轻量',
  medium: '均衡',
  high: '高',
  xhigh: '更高',
  max: '最高',
};
const num = (v: number | null | undefined) => (v == null ? '未返回' : v.toLocaleString());
function Popover({
  anchor,
  children,
  label,
  onClose,
  onEnter,
  onLeave,
  width = 280,
  className = '',
}: {
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  label: string;
  onClose: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  width?: number;
  className?: string;
}) {
  const [box, setBox] = useState({ left: 8, bottom: 60, width: 310 }),
    ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const position = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) {
        const boundedWidth = Math.min(width, window.innerWidth - 16);
        setBox({
          left: Math.max(8, Math.min(r.right - boundedWidth, window.innerWidth - boundedWidth - 8)),
          bottom: Math.max(8, window.innerHeight - r.top + 8),
          width: boundedWidth,
        });
      }
    };
    position();
    window.addEventListener('resize', position);
    const dismiss = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, onClose, width]);
  return createPortal(
    <div
      className={'composer-popover '+className}
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{ ...box, maxHeight: `calc(100vh - ${box.bottom + 8}px)` }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
    </div>,
    document.body,
  );
}
export function ComposerControls({
  state,
  run,
}: {
  state: AiState | null;
  run: (r: AiRequest) => Promise<AiState | null | undefined>;
}) {
  const [menu, setMenu] = useState<'models' | 'effort' | 'context' | null>(null),
    [query, setQuery] = useState(''),
    [id, setId] = useState('');
  const model = useRef<HTMLButtonElement>(null),
    effort = useRef<HTMLButtonElement>(null),
    context = useRef<HTMLButtonElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = () => setMenu(null),
    hold = () => {
      if (timer.current) clearTimeout(timer.current);
    },
    leave = () => {
      hold();
      timer.current = setTimeout(() => setMenu((m) => (m === 'context' ? null : m)), 180);
    };
  useEffect(() => () => hold(), []);
  const latest = state?.messages.findLast((m) => m.role === 'assistant'),
    usage = latest?.usage,
    actual = latest?.lastInput ?? usage?.input,
    used = actual ?? state?.contextEstimate ?? 0,
    capacity = state?.config.contextSize || 32768,
    pct = Math.min(100, Math.round((used / capacity) * 100));
  const efforts = [
    ...new Set([
      'auto',
      ...(state?.models.find((m) => m.id === state.config.model)?.efforts.length
        ? state.models.find((m) => m.id === state.config.model)!.efforts
        : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
      state?.config.effort || 'auto',
    ]),
  ];
  const models = [
    ...new Map(
      [{ id: state?.config.model || '', displayName: state?.config.model }, ...(state?.models || [])]
        .filter((m) => m.id)
        .map((m) => [m.id, m]),
    ).values(),
  ].filter((m) => (m.displayName || m.id).toLowerCase().includes(query.toLowerCase()));
  const select = async (req: AiRequest) => {
    if (await run(req)) close();
  };
  return (
    <div className="composer-controls">
      <button
        className={'context-indicator ' + (pct > 85 ? 'near-limit' : '')}
        ref={context}
        aria-label="上下文使用信息"
        aria-expanded={menu === 'context'}
        onMouseEnter={() => {
          hold();
          setMenu('context');
        }}
        onMouseLeave={leave}
        onFocus={() => setMenu('context')}
        onClick={() => setMenu(menu === 'context' ? null : 'context')}
      >
        <span
          className="context-mini-track"
          role="progressbar"
          aria-label="上下文占用"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <i style={{ height: pct + '%' }} />
        </span>
      </button>
      <button
        className="composer-model-button"
        ref={model}
        aria-label="选择对话模型"
        aria-expanded={menu === 'models'}
        disabled={!state || !!state.login}
        title={state?.config.model || '选择模型'}
        onClick={() => {
          hold();
          setMenu(menu === 'models' ? null : 'models');
        }}
      >
        <span>{state?.config.model || '选择模型'}</span>
        <ChevronDown size={11} />
      </button>
      <button
        className="composer-effort-button"
        ref={effort}
        aria-label="选择推理强度"
        aria-expanded={menu === 'effort'}
        disabled={!state || !!state.login}
        onClick={() => {
          hold();
          setMenu(menu === 'effort' ? null : 'effort');
        }}
      >
        {labels[state?.config.effort || 'auto']}
        <ChevronDown size={10} />
      </button>
      {menu === 'models' && state && (
        <Popover anchor={model} label="切换对话模型" onClose={close} width={248} className="model-picker-popover">
          <header>
            <b>选择模型</b>
            <button aria-label="关闭模型选择" onClick={close}>
              <X size={15} />
            </button>
          </header>
          <div className="model-menu-service">
            <select
              aria-label="对话服务商"
              value={state.config.preset}
              onChange={(e) => void run({ action: 'select', preset: e.target.value })}
            >
              {[...new Set([state.config.preset, ...Object.keys(state.profiles)])].map((id) => (
                <option key={id} value={id}>
                  {AI_PRESETS.find((p) => p.id === id)?.name || id}
                </option>
              ))}
            </select>
            <button aria-label="刷新对话模型列表" onClick={() => void run({ action: 'models' })}>
              <RefreshCw size={14} />
            </button>
          </div>
          <label className="model-menu-search">
            <Search size={14} />
            <input
              aria-label="搜索对话模型"
              placeholder="搜索可用模型…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="model-menu-list" role="listbox" aria-label="可用对话模型">
            {models.map((m) => (
              <button
                role="option"
                aria-selected={m.id === state.config.model}
                key={m.id}
                onClick={() => void select({ action: 'select', model: m.id })}
              >
                <span>{m.displayName || m.id}</span>
                {m.id === state.config.model && <Check size={14} />}
              </button>
            ))}
            {!models.length && <p>没有匹配的模型，可刷新列表或填写 ID。</p>}
          </div>
          <details className="manual-model-details"><summary>输入模型 ID</summary><form
            className="model-id-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (id.trim()) void select({ action: 'select', model: id.trim() });
            }}
          >
            <input
              aria-label="输入对话模型ID"
              placeholder="也可直接输入模型 ID"
              maxLength={200}
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
            <button disabled={!id.trim()}>使用</button>
          </form></details>
          {state.busy&&<small>下次提问生效</small>}
        </Popover>
      )}
      {menu === 'effort' && state && (
        <Popover anchor={effort} label="调整推理强度" onClose={close} width={216} className="effort-picker-popover">
          <header>
            <b title="可用程度以当前服务返回的能力为准；不支持时会保留接口错误提示。">思考程度</b>
            <button aria-label="关闭推理设置" onClick={close}>
              <X size={15} />
            </button>
          </header>
          <div className="effort-current">
            {labels[state.config.effort] || state.config.effort}
            <small>{state.config.model}</small>
          </div>
          <input
            className="effort-slider"
            aria-label="推理强度滑条"
            type="range"
            min={0}
            max={efforts.length - 1}
            step={1}
            value={Math.max(0, efforts.indexOf(state.config.effort))}
            onChange={(e) =>
              void run({ action: 'select', effort: efforts[+e.target.value] as AiConfig['effort'] })
            }
          />
          <div className="effort-steps">
            {efforts.map((v) => (
              <button
                key={v}
                aria-label={'推理 ' + (labels[v] || v)}
                aria-pressed={v === state.config.effort}
                onClick={() => void run({ action: 'select', effort: v as AiConfig['effort'] })}
              >
                {labels[v] || v}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {menu === 'context' && (
        <Popover anchor={context} label="上下文使用详情" onClose={close} onEnter={hold} onLeave={leave}>
          <header>
            <b>上下文窗口</b>
            <button aria-label="关闭上下文信息" onClick={close}>
              <X size={15} />
            </button>
          </header>
          <div className="context-percentage">
            {actual == null ? '≈' : ''}
            {pct}% 已用 <small>剩余 {Math.max(0, 100 - pct)}%</small>
          </div>
          <div className="context-wide-track">
            <i style={{ width: pct + '%' }} />
          </div>
          <p>
            已用 {actual == null ? '≈' : ''}
            {num(used)} / 共 {num(capacity)} tokens
          </p>
          <small>
            {actual == null
              ? '本地估算；实际占用以服务商返回为准。'
              : '依据最近请求的输入用量；累计消耗与窗口占用分开统计。'}
          </small>
          <button
            className="context-compact-button"
            aria-label="压缩上下文"
            disabled={!state || state.busy || state.messages.length - (state.memory?.covered || 0) < 8}
            onClick={() => void run({ action: 'compact' })}
          >
            <SlidersHorizontal size={14} />
            {state?.compacting ? '正在压缩…' : '压缩较早上下文'}
          </button>
          {state?.memory && (
            <details>
              <summary>查看较早对话摘要</summary>
              <pre>{state.memory.summary}</pre>
            </details>
          )}
        </Popover>
      )}
    </div>
  );
}
export function UsageFooter({ state }: { state: AiState | null }) {
  const [open, setOpen] = useState(false),
    ref = useRef<HTMLButtonElement>(null),
    buckets = state ? Object.values(state.cumulative.session) : [],
    total = buckets.reduce((n, v) => n + v.total, 0),
    input = buckets.reduce((n, v) => n + v.input, 0),
    output = buckets.reduce((n, v) => n + v.output, 0),
    cache = buckets.reduce((n, v) => n + v.cached, 0),
    missing = buckets.reduce((n, v) => n + v.missing, 0);
  return (
    <footer className="ai-usage-footer" aria-label="累计模型消耗">
      <button ref={ref} aria-label="查看累计用量详情" onClick={() => setOpen(!open)}>
        会话 {num(total)} tokens · 全部 {num(state?.cumulative.all.total)}
        {missing ? ' · 含未报告用量' : ''}
      </button>
      {open && (
        <Popover anchor={ref} label="累计用量详情" onClose={() => setOpen(false)}>
          <header>
            <b>累计消耗</b>
            <button aria-label="关闭用量详情" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </header>
          <dl>
            <dt>本会话输入 / 输出</dt>
            <dd>
              {num(input)} / {num(output)}
            </dd>
            <dt>累计缓存命中</dt>
            <dd>
              {num(cache)} tokens{input ? ' · ' + ((cache / input) * 100).toFixed(1) + '%' : ''}
            </dd>
            <dt>主模型 / 视觉 / 压缩</dt>
            <dd>
              {num(state?.cumulative.session.main.total)} / {num(state?.cumulative.session.vision.total)} /{' '}
              {num(state?.cumulative.session.compression.total)}
            </dd>
            <dt>最近请求费用</dt>
            <dd>
              {state && ['siwc', 'antigravity'].includes(state.config.protocol)
                ? '套餐额度'
                : state?.messages.findLast((m) => m.role === 'assistant')?.usage?.cost == null
                  ? '未返回或单价不全'
                  : '≈ $' + state.messages.findLast((m) => m.role === 'assistant')!.usage!.cost!.toFixed(6)}
            </dd>
          </dl>
          <small>累计包括工具循环、视觉与压缩；历史删除和压缩不会清空全局统计。缺失指标不补造。</small>
        </Popover>
      )}
    </footer>
  );
}
