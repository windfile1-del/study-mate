import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PenTool, Minus, Highlighter, Eraser, MousePointer2, Undo2, Trash2, Save } from 'lucide-react';
import type { InkStroke, InkTool, AnnotationPage } from '../../shared/annotations';
import './reader-enhancements.css';
const drafts = new Map<
  string,
  { page: AnnotationPage; dirty: number; saved: number; pending: Promise<void> }
>();
export function AnnotationLayer({
  id,
  page,
  revision,
  toolbar,
  onMode,
  forceSelect,
}: {
  id: string;
  page: number;
  revision: string;
  toolbar: HTMLElement | null;
  onMode: (active: boolean) => void;
  forceSelect?: boolean;
}) {
  const key = id + ':' + page;
  const [tool, setTool] = useState<InkTool>('select'),
    [color, setColor] = useState('#0f766e'),
    [strokes, setStrokes] = useState<InkStroke[]>([]),
    [liveStroke, setLiveStroke] = useState<InkStroke | null>(null),
    [message, setMessage] = useState('正在载入批注…'),
    [ready, setReady] = useState(false);
  const ref = useRef<SVGSVGElement>(null),
    stroke = useRef<InkStroke | null>(null),
    pointer = useRef<number | null>(null),
    history = useRef<InkStroke[][]>([]),
    current = useRef<ReturnType<typeof drafts.get>>(undefined),
    live = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = (rows: InkStroke[]) => {
    setStrokes(rows);
    current.current!.page.strokes = rows;
    current.current!.dirty++;
    clearTimeout(timer.current);
    setMessage('批注待保存');
    timer.current = setTimeout(() => void save(), 650);
  };
  const save = () => {
    const data = current.current;
    if (!data) return Promise.resolve();
    data.pending = data.pending
      .catch(() => {})
      .then(async () => {
        if (data.dirty === data.saved) return;
        const number = data.dirty;
        try {
          const next = await window.studyMate.annotation({
            action: 'save',
            id,
            page,
            revision,
            version: data.page.version,
            strokes: data.page.strokes,
          });
          data.page = { ...next, strokes: data.page.strokes };
          data.saved = number;
          if (live.current) setMessage(data.dirty === number ? '批注已保存' : '批注待保存');
        } catch (e) {
          if (live.current) setMessage((e as Error).message);
        }
      });
    return data.pending;
  };
  useEffect(() => {
    live.current = true;
    let active = true;
    const known = drafts.get(key);
    const load = async () => {
      const data = known || {
        page: await window.studyMate.annotation({ action: 'get', id, page, revision }),
        dirty: 0,
        saved: 0,
        pending: Promise.resolve(),
      };
      if (!active) return;
      drafts.set(key, data);
      current.current = data;
      setStrokes(data.page.strokes);
      setReady(true);
      setMessage(data.dirty === data.saved ? '批注已保存' : '有待保存批注');
    };
    void load().catch((e) => setMessage(e.message));
    return () => {
      active = false;
      live.current = false;
      clearTimeout(timer.current);
      void save();
      onMode(false);
    };
  }, [key]);
  const select = (next: InkTool) => {
    setTool(next);
    onMode(next !== 'select');
  };
  useEffect(() => {
    if (forceSelect) select('select');
  }, [forceSelect]);
  const point = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
    };
  };
  const edit = (rows: InkStroke[]) => {
    history.current = [...history.current.slice(-29), current.current!.page.strokes];
    refresh(rows);
  };
  const finish = (pointerId: number, canceled = false) => {
    if (pointer.current !== pointerId) return;
    pointer.current = null;
    if (ref.current?.hasPointerCapture(pointerId)) ref.current.releasePointerCapture(pointerId);
    if (!canceled && stroke.current && current.current) edit([...current.current.page.strokes, stroke.current]);
    stroke.current = null;
    setLiveStroke(null);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const up=(e:PointerEvent)=>finishRef.current(e.pointerId),cancel=(e:PointerEvent)=>finishRef.current(e.pointerId,true);
    const blur=()=>{if(pointer.current!==null)finishRef.current(pointer.current,true);};
    window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',blur);};
  }, []);
  const erase = (p: { x: number; y: number }) => {
    const box = ref.current!.getBoundingClientRect(),
      distance = (s: InkStroke) =>
        s.points.some((a, i) => {
          const b = s.points[Math.min(i + 1, s.points.length - 1)],
            vx = (b.x - a.x) * box.width,
            vy = (b.y - a.y) * box.height,
            wx = (p.x - a.x) * box.width,
            wy = (p.y - a.y) * box.height,
            t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
          return Math.hypot(wx - t * vx, wy - t * vy) < 12 + s.width * box.width;
        });
    const rows = current.current!.page.strokes.filter((s) => !distance(s));
    if (rows.length !== current.current!.page.strokes.length) edit(rows);
  };
  const controls = (
    <div className="ink-toolbar" role="toolbar" aria-label="文档批注">
      <div className="ink-tools">
        {(
          [
            ['select', MousePointer2, '选择文字'],
            ['pen', PenTool, '手写笔'],
            ['line', Minus, '画直线'],
            ['highlight', Highlighter, '荧光笔'],
            ['eraser', Eraser, '橡皮擦'],
          ] as const
        ).map(([mode, Icon, title]) => (
          <button
            key={mode}
            aria-label={title}
            title={title}
            className={tool === mode ? 'active' : ''}
            disabled={!ready}
            onClick={() => select(mode)}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>
      <label className="ink-color" title="批注颜色">
        <input aria-label="批注颜色" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </label>
      <button
        aria-label="撤销批注"
        disabled={!history.current.length}
        onClick={() => refresh(history.current.pop()!)}
      >
        <Undo2 size={15} />
      </button>
      <button aria-label="清除本页批注" disabled={!strokes.length} onClick={() => edit([])}>
        <Trash2 size={15} />
      </button>
      <button aria-label="保存批注" disabled={!ready} onClick={() => void save()}>
        <Save size={15} />
        保存
      </button>
      <small role="status">{message}</small>
    </div>
  );
  return (
    <>
      {toolbar && createPortal(controls, toolbar)}
      <svg
        className={'annotation-layer ' + (tool !== 'select' ? 'drawing' : '')}
        ref={ref}
        data-ink-count={strokes.length}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          if (tool === 'select' || !ready || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          pointer.current = e.pointerId;
          ref.current!.setPointerCapture(e.pointerId);
          const p = point(e);
          if (tool === 'eraser') {
            erase(p);
            return;
          }
          stroke.current = {
            id: crypto.randomUUID(),
            tool,
            color,
            width: tool === 'highlight' ? 0.016 : 0.003,
            points: [p],
          };
          setLiveStroke(stroke.current);
        }}
        onPointerMove={(e) => {
          if (pointer.current !== e.pointerId) return;
          e.preventDefault();
          const p = point(e);
          if (tool === 'eraser') {
            erase(p);
            return;
          }
          const s = stroke.current;
          if (!s) return;
          s.points = s.tool === 'line' ? [s.points[0], p] : [...s.points.slice(0, 1998), p];
          setLiveStroke({ ...s });
        }}
        onPointerUp={(e) => {
          finish(e.pointerId);
        }}
        onPointerCancel={(e) => {
          finish(e.pointerId,true);
        }}
      >
        {[...strokes, ...(liveStroke ? [liveStroke] : [])].map((s) => (
          <polyline
            key={s.id}
            points={s.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width * 1000}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={s.tool === 'highlight' ? 0.3 : 1}
          />
        ))}
      </svg>
    </>
  );
}
