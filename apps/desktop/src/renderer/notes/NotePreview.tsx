import { createElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { Element, RootContent } from 'hast';
import { compileInWorker } from './compiler-client';
import type { CompiledNote } from './markdown';
import { headingKey } from './heading';
import { MermaidDiagram } from './MermaidDiagram';
import 'katex/dist/katex.min.css';
import './notes.css';

interface Props {
  source: string;
  path: string;
  vaultId: string;
  anchor?: string;
  onNavigate: (target: string, wiki: boolean, base?: string) => void;
  depth?: number;
  initialOffset?: number;
  onOffset?: (offset: number) => void;
  restoreScope?: string;
}
const measurements = new Map<string, { source: string; snapshot: VirtualItem[] }>();
const isExternal = (target: string) => /^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//');
function NoteImage({
  target,
  wiki,
  width,
  alt,
  context,
}: {
  target: string;
  wiki: boolean;
  width?: number;
  alt: string;
  context: Props;
}) {
  const [url, setUrl] = useState(''),
    [error, setError] = useState('');
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setUrl('');
    setError('');
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (isExternal(target)) {
          setError('外部图片未自动加载，可在源码中查看链接。');
          return;
        }
        void window.studyMate.noteImage(context.vaultId, context.path, target, wiki).then(
          (value) => {
            if (live) setUrl(value);
          },
          (cause) => {
            if (live) setError(cause.message);
          },
        );
      },
      { rootMargin: '300px' },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      live = false;
      observer.disconnect();
      if (/^https?:\/\//i.test(target) || /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(target)) {
        setUrl(target);
        return;
      }
    };
  }, [target, wiki, context.vaultId, context.path]);
  return (
    <span ref={host} className="note-image" data-state={error ? 'error' : url ? 'ready' : 'loading'}>
      {url ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={width ? { width: Math.min(width, 4096) } : undefined}
          onError={() => {
            setError('图片已移动或无法解码：' + target);
            setUrl('');
          }}
        />
      ) : (
        <span className={error ? 'attachment-error' : 'muted'}>{error || '加载图片…'}</span>
      )}
    </span>
  );
}
function EmbeddedNote({ target, context }: { target: string; context: Props }) {
  const [document, setDocument] = useState<{ content: string; path: string; anchor: string } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.studyMate
      .resolveNoteLink(context.vaultId, context.path, target, true)
      .then(async (link) => {
        if (link.path === context.path || (context.depth || 0) >= 1)
          throw new Error('循环或多层嵌入，请点击引用打开原笔记。');
        const note = await window.studyMate.readNote(link.path);
        if (live) setDocument({ ...note, anchor: link.anchor });
      })
      .catch((cause) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [target, context.path, context.vaultId]);
  return (
    <section className="embedded-note">
      <button className="note-internal-link" onClick={() => context.onNavigate(target, true)}>
        ↗ {target}
      </button>
      {document ? (
        <NotePreview
          {...context}
          source={document.content}
          path={document.path}
          anchor={document.anchor}
          depth={(context.depth || 0) + 1}
        />
      ) : (
        <p className="muted">{error || '正在读取嵌入笔记…'}</p>
      )}
    </section>
  );
}
function renderNode(node: RootContent, key: number, context: Props): ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return null;
  const properties = node.properties;
  const children = node.children.map((child, index) => renderNode(child, index, context));
  if (node.tagName === 'img')
    return (
      <NoteImage
        key={key}
        target={String(properties.src || '')}
        wiki={properties.dataWiki === 'true'}
        width={typeof properties.width === 'number' ? properties.width : undefined}
        alt={String(properties.alt || '')}
        context={context}
      />
    );
  if (node.tagName === 'a') {
    const href = String(properties.href || '');
    if (properties.dataEmbed) return <EmbeddedNote key={key} target={href} context={context} />;
    if (isExternal(href))
      return (
        <a
          key={key}
          href="#"
          className="note-external-link"
          title={href}
          onClick={(event) => {
            event.preventDefault();
            context.onNavigate(href, false);
          }}
        >
          {children} ↗
        </a>
      );
    return (
      <a
        key={key}
        href="#"
        className="note-internal-link"
        onClick={(event) => {
          event.preventDefault();
          context.onNavigate(href, properties.dataWiki === 'true');
        }}
      >
        {children}
      </a>
    );
  }
  if (node.tagName === 'pre') {
    const code = node.children.find((child) => child.type === 'element' && child.tagName === 'code') as
      Element | undefined;
    if (
      code &&
      Array.isArray(code.properties.className) &&
      code.properties.className.includes('language-mermaid')
    ) {
      const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
      return <MermaidDiagram key={key} source={source} />;
    }
  }
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(properties)) {
    if (name === 'className') props.className = Array.isArray(value) ? value.join(' ') : value;
    else if (name === 'style' && typeof value === 'string') {
      const style: Record<string, string> = {};
      for (const declaration of value.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon <= 0) continue;
        const property = declaration
          .slice(0, colon)
          .trim()
          .replace(/-([a-z])/g, (_m, letter: string) => letter.toUpperCase());
        style[property] = declaration.slice(colon + 1).trim();
      }
      props.style = style;
    } else if (name === 'dataCallout') props['data-callout'] = value;
    else if (/^(aria|data)[A-Z]/.test(name))
      props[name.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())] = value;
    else if (['type', 'checked', 'disabled'].includes(name) && node.tagName === 'input') {
      props[name] = value;
      props.readOnly = true;
      props.disabled = true;
    } else if (!/^(on|dangerously|srcDoc|href|src|dataWiki|dataEmbed)/i.test(name)) props[name] = value;
  }
  return createElement(
    node.tagName,
    props,
    ['br', 'hr', 'input', 'wbr', 'source'].includes(node.tagName) ? undefined : children,
  );
}
const Block = memo(function Block({ node, context }: { node: RootContent; context: Props }) {
  return renderNode(node, 0, context);
});
export const NotePreview = memo(function NotePreview(props: Props) {
  const restoreKey = props.vaultId + '\n' + props.path + '\n' + (props.restoreScope || 'embed');
  const stored = useRef(measurements.get(restoreKey));
  const latestSource = useRef(props.source);
  latestSource.current = props.source;
  const [compiled, setCompiled] = useState<CompiledNote | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(true);
  const firstPaint = useRef(false);
  const identity = useRef('');
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const key = props.vaultId + '\n' + props.path;
    const keepPrevious = identity.current === key && firstPaint.current;
    identity.current = key;
    setLoading(!keepPrevious);
    setParsing(true);
    setError('');
    if (!keepPrevious) {
      setCompiled(null);
      firstPaint.current = false;
    }
    const timer = setTimeout(() => {
      void compileInWorker(props.source, controller.signal, (value) => {
        if (!controller.signal.aborted && !keepPrevious) {
          setCompiled(value);
          setLoading(false);
        }
      }).then(
        (value) => {
          if (!controller.signal.aborted) {
            setCompiled(value);
            setLoading(false);
            setParsing(false);
          }
        },
        (cause) => {
          if (!controller.signal.aborted) {
            setError(cause.message);
            setLoading(false);
            setParsing(false);
          }
        },
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [props.source, props.path, props.vaultId]);
  const virtual = useVirtualizer({
    count: compiled?.blocks.length || 0,
    getScrollElement: () => scroll.current,
    estimateSize: () => 100,
    overscan: 4,
    initialMeasurementsCache: stored.current?.source === props.source ? stored.current.snapshot : [],
  });
  useEffect(
    () => () => {
      measurements.delete(restoreKey);
      measurements.set(restoreKey, { source: latestSource.current, snapshot: virtual.takeSnapshot() });
      while (measurements.size > 8) measurements.delete(measurements.keys().next().value!);
    },
    [restoreKey],
  );
  const goTo = (id: string) => {
    const normalized = headingKey(id.replace(/^#/, ''));
    const heading = compiled?.headings.find(
      (item) => item.id === id || item.id === normalized || headingKey(item.text) === normalized,
    );
    const block =
      heading?.block ??
      compiled?.anchors[id] ??
      compiled?.anchors['user-content-' + id] ??
      (id.startsWith('^') ? compiled?.anchors['user-content-obs-block-' + id.slice(1)] : undefined);
    if (block === undefined) return;
    virtual.scrollToIndex(block, { align: 'start' });
    setTimeout(() => virtual.scrollToIndex(block, { align: 'start' }), 80);
  };
  useEffect(() => {
    if (compiled && props.anchor) {
      goTo(props.anchor);
      firstPaint.current = true;
    } else if (compiled && !firstPaint.current && (!parsing || !props.initialOffset)) {
      virtual.scrollToOffset(props.initialOffset || 0);
      firstPaint.current = true;
    }
  }, [compiled, props.anchor, parsing]);
  const context = {
    ...props,
    onNavigate: (target: string, wiki: boolean, from?: string) => {
      if (target.startsWith('#')) goTo(decodeURIComponent(target.slice(1)));
      else props.onNavigate(target, wiki, from || props.path);
    },
  };
  return (
    <div
      className={'note-preview ' + (props.depth ? 'note-preview-embedded' : '')}
      data-loading={loading}
      data-compiling={parsing}
      data-parse-ms={compiled?.milliseconds}
      data-block-count={compiled?.blocks.length || 0}
    >
      <div className="note-reading-tools">
        <span>
          {loading
            ? '后台排版中…'
            : error
              ? '解析未完成'
              : parsing
                ? '余文后台排版中…'
                : compiled?.warnings
                  ? '部分公式无法识别，已保留原文'
                  : 'Obsidian 常用语法'}
        </span>
        {compiled && compiled.headings.length > 0 && (
          <select aria-label="笔记目录" value="" onChange={(event) => goTo(event.target.value)}>
            <option value="" disabled>
              目录 · {compiled.headings.length} 节
            </option>
            {compiled.headings.map((item) => (
              <option key={item.id} value={item.id}>
                {'　'.repeat(Math.max(0, item.depth - 1)) + item.text.slice(0, 100)}
              </option>
            ))}
          </select>
        )}
      </div>
      {compiled?.properties && (
        <details className="note-properties">
          <summary>笔记属性</summary>
          <pre>{compiled.properties}</pre>
        </details>
      )}
      {error && <div className="attachment-error">{error} · 可切换到源码继续编辑。</div>}
      <div
        ref={scroll}
        className="note-preview-scroll"
        onWheel={() => {
          if (compiled) firstPaint.current = true;
        }}
        onTouchMove={() => {
          if (compiled) firstPaint.current = true;
        }}
        onScroll={(event) => {
          if (firstPaint.current) props.onOffset?.(event.currentTarget.scrollTop);
        }}
      >
        {loading && (
          <div className="note-skeleton">
            <span />
            <span />
            <span />
            <p>正在后台解析公式与笔记内容，可以继续切换笔记。</p>
          </div>
        )}
        {compiled && (
          <div
            className="note-virtual-content wmde-markdown"
            style={{ height: virtual.getTotalSize(), position: 'relative' }}
          >
            {virtual.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtual.measureElement}
                className="note-rendered-block"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: 'translateY(' + item.start + 'px)',
                }}
              >
                <Block node={compiled.blocks[item.index]} context={context} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
