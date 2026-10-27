import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import { Maximize2, X, Minus, Plus } from 'lucide-react';
let mermaidLibrary: Promise<(typeof import('mermaid'))['default']> | undefined;
let renderTail: Promise<unknown> = Promise.resolve();
const diagrams = new Map<string, Promise<string>>();
function renderDiagram(source: string): Promise<string> {
  if (diagrams.has(source)) return diagrams.get(source)!;
  const task = renderTail.then(async () => {
    if (source.length > 50000) throw new Error('图表超过50000字符，请拆分后预览。');
    mermaidLibrary ||= import('mermaid').then((module) => module.default);
    const mermaid = await mermaidLibrary;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'base',
      fontFamily: 'Microsoft YaHei, sans-serif',
      maxTextSize: 50000,
      maxEdges: 500,
      suppressErrorRendering: true,
      secure: [
        'securityLevel',
        'htmlLabels',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
      ],
      themeVariables: {
        primaryColor: '#eef7f5',
        primaryTextColor: '#0f2924',
        primaryBorderColor: '#6eb5a5',
        lineColor: '#4b8678',
        fontFamily: 'Microsoft YaHei, sans-serif',
      },
    });
    const id = 'diagram-' + crypto.randomUUID();
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden';
    document.body.append(container);
    try {
      // Per-diagram directives cannot weaken the application configuration.
      const clean = source.replace(/%%\{[\s\S]*?\}%%/g, '').replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n/, '');
      const { svg } = await mermaid.render(id, clean, container);
      const safe = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject', 'image', 'iframe'],
        FORBID_ATTR: ['onload', 'onclick'],
      });
      const parsed = new DOMParser().parseFromString(safe, 'image/svg+xml');
      const graphic = parsed.documentElement;
      const box = graphic.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
      if (box?.length === 4 && box[2] > 0 && box[3] > 0) {
        graphic.setAttribute('width', String(Math.ceil(box[2])));
        graphic.setAttribute('height', String(Math.ceil(box[3])));
        graphic.removeAttribute('style');
      }
      return (
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(new XMLSerializer().serializeToString(graphic))
      );
    } finally {
      container.remove();
      document.getElementById('d' + id)?.remove();
    }
  });
  renderTail = task.catch(() => {});
  diagrams.set(source, task);
  if (diagrams.size > 32) diagrams.delete(diagrams.keys().next().value!);
  return task;
}
export function MermaidDiagram({ source }: { source: string }) {
  const [image, setImage] = useState(''),
    [error, setError] = useState(''),
    [expanded, setExpanded] = useState(false),
    [scale, setScale] = useState(1);
  useEffect(() => {
    let live = true;
    setImage('');
    setError('');
    const timeout = setTimeout(() => {
      void renderDiagram(source).then(
        (value) => {
          if (live) setImage(value);
        },
        (cause) => {
          if (live) setError(String(cause.message || cause));
        },
      );
    }, 100);
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [source]);
  useEffect(() => {
    if (!expanded) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [expanded]);
  return (
    <figure className="mermaid-diagram">
      <div className="diagram-caption">
        <span>Mermaid 图表</span>
        {image && (
          <button
            onClick={() => {
              setScale(1);
              setExpanded(true);
            }}
            aria-label="放大图表"
          >
            <Maximize2 size={13} />
            放大
          </button>
        )}
      </div>
      {image ? (
        <div className="diagram-canvas">
          <img src={image} alt="Mermaid 图表" className="diagram-image" />
        </div>
      ) : (
        <p className={error ? 'diagram-error' : 'muted'}>
          {error ? '图表语法无法解析，请展开源码检查。' : '正在绘制图表…'}
        </p>
      )}
      <details>
        <summary>查看图表源码{error ? '与错误' : ''}</summary>
        {error && <p className="diagram-error">{error}</p>}
        <pre>
          <code>{source}</code>
        </pre>
      </details>
      {expanded &&
        createPortal(
          <div
            className="diagram-modal"
            role="dialog"
            aria-modal="true"
            aria-label="图表大图"
            onClick={() => setExpanded(false)}
          >
            <div className="diagram-modal-tools" onClick={(event) => event.stopPropagation()}>
              <button aria-label="缩小图表" onClick={() => setScale((value) => Math.max(0.5, value - 0.25))}>
                <Minus size={16} />
              </button>
              <span>{Math.round(scale * 100)}%</span >
              <button aria-label="放大一级" onClick={() => setScale((value) => Math.min(3, value + 0.25))}>
                <Plus size={16} />
              </button>
              <button aria-label="关闭大图" onClick={() => setExpanded(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="diagram-modal-scroll" onClick={(event) => event.stopPropagation()}>
              <img
                src={image}
                alt="Mermaid 图表大图"
                style={{ width: scale * 100 + '%', maxWidth: 'none' }}
              />
            </div>
          </div>,
          document.body,
        )}
    </figure>
  );
}
