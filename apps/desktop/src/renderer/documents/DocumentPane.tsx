import type {OcrResult} from '../../shared/recognition';
import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  List,
  Search,
  ZoomIn,
  ZoomOut,
  Scan,
  Type,
  ArrowRightLeft,
  LockKeyhole,
  LoaderCircle,
} from 'lucide-react';
import type { DocumentContext, DocumentInfo, DocumentPage, DocumentRegion } from '../../shared/documents';
import './documents.css';
import{PageThumbnails}from'./PageThumbnails';import{AnnotationLayer}from'./AnnotationLayer';
const api = window.studyMate;
export function DocumentPane({
  id,
  initialPage,
  onContext,
  onDock,
  onAskImage,
}: {
  id: string;
  initialPage?: number;
  onContext: (value: DocumentContext) => void;
  onDock: () => void;
  onAskImage?:(source:OcrResult['source'])=>void;
}) {
  const [info, setInfo] = useState<DocumentInfo | null>(null),
    [page, setPage] = useState(initialPage || 1),
    [content, setContent] = useState<DocumentPage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [zoom, setZoom] = useState(1),
    [outline, setOutline] = useState(false),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<{ page: number; snippet: string }[]>([]),
    [next, setNext] = useState<number | null>(null),
    [password, setPassword] = useState(''),
    [regionMode, setRegionMode] = useState(false),
    [selection, setSelection] = useState<{ text: string; region?: DocumentRegion }>(),
    [region, setRegion] = useState<DocumentRegion>(),
    [searching, setSearching] = useState(false),
    [retry, setRetry] = useState(0);
  const[outlineTab,setOutlineTab]=useState<'outline'|'thumbnails'>('thumbnails'),[inkActive,setInkActive]=useState(false),[inkToolbar,setInkToolbar]=useState<HTMLDivElement|null>(null),[wheelPages,setWheelPages]=useState(true);const lastWheel=useRef(0),wheelTotal=useRef(0);
  const stage = useRef<HTMLDivElement>(null),
    sheet = useRef<HTMLDivElement>(null),
    start = useRef<{ x: number; y: number } | null>(null),
    [width, setWidth] = useState(800);
  const contextRef = useRef(onContext);
  contextRef.current = onContext;
  useEffect(() => {
    let live = true;
    setInfo(null);
    setContent(null);
    setError('');
    void api
      .document({ action: 'get', id })
      .then((r) => {
        if (live) {
          setInfo(r.document);
          if(r.document.kind!=='pdf')setOutline(true);
          setPage(initialPage || r.document.lastPage || 1);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    if (initialPage) setPage(initialPage);
  }, [initialPage]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const update=()=>{if(!el.closest('.app')?.classList.contains('resizing'))setWidth(Math.max(260,el.clientWidth-48));};
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('study-layout-settled',update);
    return () => {observer.disconnect();window.removeEventListener('study-layout-settled',update);};
  }, []);
  useEffect(() => {
    setSelection(undefined);
    setRegion(undefined);
  }, [id, page]);
  useEffect(() => {
    if (info) contextRef.current({ id: info.id, revision: info.revision, page, selection });
  }, [info?.id, info?.revision, page, selection]);
  useEffect(() => {
    if (!info || info.locked) return;
    let live = true;
    setBusy(true);
    setError('');
    setContent(null);
    const timer = setTimeout(() => {
      void api
        .document({
          action: 'page',
          id,
          page,
          width: Math.min(2400, Math.max(600, Math.round(width * zoom * 1.4))),
          image: info.kind !== 'ppt',
        })
        .then((r) => {
          if (live) {
            setInfo(r.document);
            setContent(r.page!);
            void api.document({ action: 'locate', id, page }).catch(() => {});
          }
        })
        .catch((e) => live && setError(e.message))
        .finally(() => live && setBusy(false));
    }, 100);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, info?.locked, info?.kind, page, width, zoom, retry]);
  const go = (n: number) => {
    if (info) setPage(Math.min(info.pages || 1, Math.max(1, n)));
  };
  useEffect(()=>{const node=stage.current;if(!node||!info||info.kind==='pdf'||!wheelPages)return;const wheel=(e:WheelEvent)=>{if(e.ctrlKey||e.metaKey||e.shiftKey||inkActive||Math.abs(e.deltaX)>Math.abs(e.deltaY))return;if((e.target as HTMLElement).closest('.document-notes,input,textarea'))return;const atEdge=e.deltaY>0?node.scrollTop+node.clientHeight>=node.scrollHeight-2:node.scrollTop<=1;if(zoom>1&&!atEdge)return;e.preventDefault();if(busy||Date.now()-lastWheel.current<400)return;wheelTotal.current+=e.deltaY*(e.deltaMode===1?16:1);if(Math.abs(wheelTotal.current)<45)return;go(page+(wheelTotal.current>0?1:-1));lastWheel.current=Date.now();wheelTotal.current=0;};node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);},[page,info?.id,info?.kind,wheelPages,busy,zoom,inkActive]);
  const search = async (from = 1) => {
    setSearching(true);
    setError('');
    try {
      const r = await api.document({ action: 'search', id, query, start: from, limit: 20 });
      setHits((prev) => (from === 1 ? r.hits || [] : [...prev, ...(r.hits || [])]));
      setNext(r.nextPage ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const point = (event: React.PointerEvent) => {
    const b = sheet.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - b.left) / b.width)),
      y: Math.min(1, Math.max(0, (event.clientY - b.top) / b.height)),
    };
  };
  return (
    <section
      className="document-pane"
      data-document-id={id}
      tabIndex={0}
      onKeyDown={e=>{if((e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')||e.ctrlKey||e.metaKey||e.altKey)return;const directions:Record<string,number>={ArrowLeft:-1,ArrowUp:-1,PageUp:-1,ArrowRight:1,ArrowDown:1,PageDown:1};if(e.key in directions){e.preventDefault();e.stopPropagation();go(page+directions[e.key]);}else if(e.key==='Home'||e.key==='End'){e.preventDefault();go(e.key==='Home'?1:info?.pages||1);}}}
      onMouseUp={(e) => {
        if (regionMode) return;
        const selected = window.getSelection();
        if (selected?.anchorNode && e.currentTarget.contains(selected.anchorNode) && !selected.isCollapsed) {
          const text = selected.toString().slice(0, 8000);
          if (text) setSelection({ text });
        }
      }}
      onFocusCapture={() => {
        if (info) onContext({ id, revision: info.revision, page, selection });
      }}
    >
      <header className="document-title">
        <span className="document-badge">{info?.kind.toUpperCase() || '文档'}</span>
        <strong title={info?.title}>{info?.title || '正在打开文档'}</strong>
        <button title="文档移至另一侧" aria-label="文档移至另一侧" onClick={onDock}>
          <ArrowRightLeft size={16} />
        </button>
      </header>
      <div className="document-toolbar">
        <button title="目录与搜索" onClick={() => setOutline(!outline)}>
          <List size={16} />
        </button>
        {info?.kind!=='pdf'&&<button title="滚轮可直接翻页；放大后优先滚动页面" aria-label="滚轮翻页" aria-pressed={wheelPages} className={wheelPages?'active':''} onClick={()=>setWheelPages(!wheelPages)}>滚轮翻页</button>}
        <button aria-label="上一页" disabled={page <= 1 || !info} onClick={() => go(page - 1)}>
          <ChevronLeft size={16} />
        </button>
        <label>
          <input
            aria-label="文档页码"
            type="number"
            min="1"
            max={info?.pages || 1}
            value={page}
            onChange={(e) => go(Number(e.target.value) || 1)}
          />{' '}
          / {info?.pages || '—'}
        </label>
        <button aria-label="下一页" disabled={!info || page >= info.pages} onClick={() => go(page + 1)}>
          <ChevronRight size={16} />
        </button>
        <span className="document-toolbar-spacer" />
        <button aria-label="缩小页面" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
          <ZoomOut size={16} />
        </button>
        <button title="适合宽度" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button aria-label="放大页面" onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))}>
          <ZoomIn size={16} />
        </button>
        <button
          title={regionMode ? '切换文字选择' : '框选图表，供 AI 按需查看'}
          className={regionMode ? 'active' : ''}
          onClick={() => setRegionMode(!regionMode)}
        >
          {regionMode ? <Scan size={16} /> : <Type size={16} />}
        </button>
        {onAskImage&&<button title="让多模态AI查看当前页或选区原图" disabled={!info||info.locked||info.kind==='ppt'} onClick={()=>onAskImage({kind:'document',id,page,region:selection?.region})}>让 AI 看本页</button>}
      </div>
      <div ref={setInkToolbar}/>
      {info?.warning && <div className="document-notice">{info.warning}</div>}
      {selection && (
        <div className="document-selection">
          已选{selection.region ? '图表区域' : `${selection.text.length}字`} · 提问时只附选区与页码
          <button
            onClick={() => {
              setSelection(undefined);
              setRegion(undefined);
            }}
          >
            清除
          </button>
        </div>
      )}
      {error && (
        <div className="document-error" role="alert">
          {error}
          <button onClick={() => setRetry((n) => n + 1)}>重试本页</button>
        </div>
      )}
      <div className="document-body">
        {outline && (
          <aside className="document-outline">
            <div className="document-outline-tabs"><button className={outlineTab==='thumbnails'?'active':''} onClick={()=>setOutlineTab('thumbnails')}>全部缩略图</button><button className={outlineTab==='outline'?'active':''} onClick={()=>setOutlineTab('outline')}>目录与搜索</button></div>
            {outlineTab==='thumbnails'&&info?<PageThumbnails info={info} page={page} onPage={go} busy={busy}/>:<>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input
                aria-label="搜索文档"
                placeholder="搜索可提取文字…"
                maxLength={200}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button disabled={!query.trim() || searching}>
                <Search size={15} />
              </button>
            </form>
            {query &&
              hits.map((h, i) => (
                <button key={i} className="document-hit" onClick={() => go(h.page)}>
                  <b>第 {h.page} 页</b>
                  <span>{h.snippet}</span>
                </button>
              ))}
            {next && (
              <button disabled={searching} onClick={() => void search(next)}>
                继续搜索第 {next} 页起
              </button>
            )}
            <small>{searching ? '正在搜索…' : '目录 / 幻灯片'}</small>
            {info?.outline.map((o, i) => (
              <button
                key={i}
                title={o.title}
                className={page === o.page ? 'active' : ''}
                style={{ paddingLeft: 12 + Math.min(o.depth, 6) * 10 }}
                onClick={() => go(o.page)}
              >
                <span>{o.title}</span>
                <em>{o.page}</em>
              </button>
            ))}
            {!info?.outline.length && <p>文档没有内置目录，可通过页码跳转。</p>}
            </>}
          </aside>
        )}
        <div className="document-stage" ref={stage}>
          {info?.locked ? (
            <form
              className="document-locked"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                void api
                  .document({ action: 'unlock', id, password })
                  .then((r) => {
                    setInfo(r.document);
                    setPassword('');
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <LockKeyhole size={32} />
              <h3>解锁此 PDF</h3>
              <p>密码仅在本次运行内存中使用，不发给 AI。</p>
              <input
                aria-label="PDF密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
              <button disabled={busy || !password}>打开文档</button>
            </form>
          ) : busy ? (
            <div className="document-loading">
              <LoaderCircle size={24} className="spin" />
              <span>正在排版第 {page} 页…</span>
            </div>
          ) : (
            content && (
              <>
                <div
                  className={'document-sheet ' + (regionMode ? 'region-mode' : '')}
                  ref={sheet}
                  style={{
                    width: Math.max(240, width * zoom),
                    aspectRatio: content.image ? `${content.width}/${content.height}` : undefined,
                  }}
                  onPointerDown={(e) => {
                    if(!regionMode&&!inkActive)e.currentTarget.closest<HTMLElement>('.document-pane')?.focus({preventScroll:true});
                    if (!regionMode) return;
                    e.preventDefault();
                    start.current = point(e);
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setRegion(undefined);
                  }}
                  onPointerMove={(e) => {
                    if (!start.current || !regionMode) return;
                    const p = point(e),
                      s = start.current;
                    setRegion({
                      x: Math.min(p.x, s.x),
                      y: Math.min(p.y, s.y),
                      width: Math.abs(p.x - s.x),
                      height: Math.abs(p.y - s.y),
                    });
                  }}
                  onPointerUp={(e) => {
                    if(inkActive)return;
                    if (regionMode) {
                      start.current = null;
                      if (e.currentTarget.hasPointerCapture(e.pointerId))
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      if (region && region.width > 0.005 && region.height > 0.005)
                        setSelection({ text: '', region });
                    } else {
                      const text = window.getSelection()?.toString().slice(0, 8000) || '';
                      if (text) setSelection({ text });
                    }
                  }}
                  onPointerCancel={() => {
                    start.current = null;
                    setRegion(undefined);
                  }}
                >
                  {content.image ? (
                    <>
                      <img alt={`第 ${page} 页`} src={content.image} draggable={false} />
                      {!regionMode && (
                        <svg
                          className="document-text-layer"
                          viewBox={`0 0 ${content.width} ${content.height}`}
                          preserveAspectRatio="none"
                        >
                          {content.blocks.map((b, i) => (
                            <text
                              key={i}
                              x={b.x * content.width}
                              y={(b.y + b.height * 0.8) * content.height}
                              fontSize={b.height * content.height}
                              textLength={Math.max(1, b.width * content.width)}
                              lengthAdjust="spacingAndGlyphs"
                            >
                              {b.text}
                            </text>
                          ))}
                        </svg>
                      )}
                      {region && (
                        <div
                          className="document-region"
                          style={{
                            left: region.x * 100 + '%',
                            top: region.y * 100 + '%',
                            width: region.width * 100 + '%',
                            height: region.height * 100 + '%',
                          }}
                        />
                      )}
                    </>
                  ) : (
                    <article className="legacy-slide">
                      <small>简化文字 · 第 {page} 张</small>
                      <h2>{content.text.split('\n')[0]}</h2>
                      <pre>{content.text.split('\n').slice(1).join('\n')}</pre>
                    </article>
                  )}
                  {info&&!info.locked&&<AnnotationLayer key={id+':'+page} id={id} page={page} revision={info.revision} toolbar={inkToolbar} forceSelect={regionMode} onMode={active=>{setInkActive(active);if(active)setRegionMode(false);}}/>}
                </div>
                {content.notes && (
                  <details className="document-notes">
                    <summary>演讲者备注</summary>
                    <p>{content.notes}</p>
                  </details>
                )}
                <details className="document-notes">
                  <summary>本页文字与识别说明</summary>
                  <pre>{content.text || '没有可提取文字，请用视觉模型查看页面。'}</pre>
                  {content.gaps.map((g, i) => (
                    <p key={i}>{g}</p>
                  ))}
                </details>
              </>
            )
          )}
        </div>
      </div>
      <footer className="document-footer">
        本地离线阅读 · 原文件保持不变<span>第 {page} 页 · AI 按需读取</span>
      </footer>
    </section>
  );
}
