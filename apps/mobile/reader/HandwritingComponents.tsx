import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  appendPointFiltered,
  buildStrokeRenderData,
  eraseStrokesAtSegment,
  findAnchorBlockForY,
  getStrokeBoundingBox,
  hitTestStroke,
  resolveAnchoredStrokes,
  type BlockLayoutOffset,
  type StrokeRenderData,
} from './ink-geometry';
import {
  createDefaultPenProfiles,
  EXTENDED_INK_COLORS,
  HIGHLIGHT_COLORS,
  INK_COLORS,
  PAD_BACKGROUNDS,
  PEN_BRUSH_ORDER,
  PEN_BRUSH_SPECS,
  type HandwritingPad,
  type InkActiveTool,
  type InkBrushId,
  type InkEraserMode,
  type InkHeadingRef,
  type InkPoint,
  type InkStroke,
  type PadBackground,
  type PenProfile,
} from './ink-types';

function nextId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isStylusEraser(e: PointerEvent | React.PointerEvent): boolean {
  return (
    e.pointerType === 'pen' &&
    (e.button === 5 || (e.buttons & 32) !== 0 || e.button === 2 || (e.buttons & 2) !== 0)
  );
}

function canWriteWithPointer(e: PointerEvent | React.PointerEvent, allowMouse: boolean): boolean {
  if (e.pointerType === 'pen') return true;
  if (allowMouse && e.pointerType === 'mouse' && e.button === 0) return true;
  // Finger touch ('touch') NEVER writes or erases — even when a brush or eraser tool is selected.
  return false;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function roundLogical(v: number): number {
  return Math.round(v * 100) / 100;
}

function roundNormalized(v: number): number {
  return Math.round(v * 100000) / 100000;
}

function snapLinePoint(start: InkPoint, end: InkPoint, scaleX: number, scaleY: number): InkPoint {
  const dx = (end.x - start.x) * scaleX;
  const dy = (end.y - start.y) * scaleY;
  const dist = Math.hypot(dx, dy);
  if (dist < 18) return end;
  const angle = Math.atan2(dy, dx);
  const snapAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI];
  for (const target of snapAngles) {
    if (Math.abs(angle - target) < (4 * Math.PI) / 180) {
      return {
        ...end,
        x: scaleX > 10 ? roundNormalized(start.x + (Math.cos(target) * dist) / scaleX) : roundLogical(start.x + (Math.cos(target) * dist) / scaleX),
        y: roundLogical(start.y + (Math.sin(target) * dist) / scaleY),
      };
    }
  }
  return end;
}

function triggerLightHaptic() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(14);
    }
  } catch {
    // ignore if unsupported or blocked
  }
}

/* ===========================
 * Path2D WeakMap Stroke Cache & Canvas Drawing
 * =========================== */

const strokePathCache = new WeakMap<
  InkStroke,
  { key: string; path: Path2D; render: StrokeRenderData }
>();

function getCompiledStroke(stroke: InkStroke, scaleX: number, scaleY: number, useCache: boolean) {
  const key = `${scaleX.toFixed(4)}:${scaleY.toFixed(4)}`;
  if (useCache) {
    const cached = strokePathCache.get(stroke);
    if (cached && cached.key === key) return cached;
  }
  const render = buildStrokeRenderData(stroke, scaleX, scaleY);
  const path = render.d ? new Path2D(render.d) : new Path2D();
  const entry = { key, path, render };
  if (useCache) strokePathCache.set(stroke, entry);
  return entry;
}

function drawStrokeToCanvas(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  scaleX: number,
  scaleY: number,
  useCache: boolean,
) {
  if (stroke.points.length === 0) return;
  const { path, render } = getCompiledStroke(stroke, scaleX, scaleY, useCache);
  if (!render.d) return;

  ctx.save();
  ctx.globalAlpha = render.opacity;
  ctx.globalCompositeOperation = render.multiply ? 'multiply' : 'source-over';
  if (render.mode === 'fill') {
    ctx.fillStyle = render.color;
    ctx.fill(path);
  } else {
    ctx.strokeStyle = render.color;
    ctx.lineWidth = render.strokeWidth ?? stroke.width;
    ctx.lineCap = render.linecap ?? 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  ctx.restore();
}

function drawEraserCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  isLongPress: boolean,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = isLongPress ? 'rgba(217, 119, 6, 0.14)' : 'rgba(15, 118, 110, 0.08)';
  ctx.fill();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = isLongPress ? '#D97706' : '#0F766E';
  ctx.stroke();
  ctx.restore();
}

/* ===========================
 * Scroll Container & Stylus-vs-Finger Touch Helpers
 * =========================== */

function findScrollContainer(el: Element | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    if (node.classList.contains('pad-fullscreen-scroll') || node.classList.contains('note-preview-scroll')) {
      return node;
    }
    const style = window.getComputedStyle(node);
    const oy = style.overflowY;
    const ox = style.overflowX;
    if (
      ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) ||
      ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 2)
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function touchEventHasStylus(e: TouchEvent): boolean {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i] as Touch & { touchType?: string };
    if (t.touchType === 'stylus') return true;
  }
  for (let i = 0; i < e.touches.length; i++) {
    const t = e.touches[i] as Touch & { touchType?: string };
    if (t.touchType === 'stylus') return true;
  }
  return false;
}

export function scrollElementIntoPreview(el: HTMLElement | null) {
  if (!el) return;
  const scroller = findScrollContainer(el);
  if (!scroller) return;
  const elRect = el.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  const targetTop =
    scroller.scrollTop + (elRect.top - scRect.top) - Math.max(24, (scRect.height - elRect.height) * 0.35);
  scroller.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'smooth',
  });
}

/* ===========================
 * Shared Tool Session & Floating Toolbox
 * =========================== */

export interface InkToolSession {
  tool: InkActiveTool;
  activeBrush: InkBrushId;
  profiles: Record<InkBrushId, PenProfile>;
  recentColors: string[];
  eraserRadius: number;
  eraserMode: InkEraserMode;
  selectTool: (tool: InkActiveTool) => void;
  updateProfile: (brush: InkBrushId, next: PenProfile) => void;
  addRecentColor: (hex: string) => void;
  setEraserRadius: (radius: number) => void;
  setEraserMode: (mode: InkEraserMode) => void;
}

export function useInkToolSession(widthScale = 1): InkToolSession {
  const [tool, setTool] = useState<InkActiveTool>('fountain');
  const [activeBrush, setActiveBrush] = useState<InkBrushId>('fountain');
  const [profiles, setProfiles] = useState<Record<InkBrushId, PenProfile>>(() =>
    createDefaultPenProfiles(widthScale),
  );
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [eraserRadius, setEraserRadius] = useState<number>(16);
  const [eraserMode, setEraserMode] = useState<InkEraserMode>('partial');

  const selectTool = useCallback((next: InkActiveTool) => {
    setTool(next);
    if (next !== 'eraser' && next !== 'browse') {
      setActiveBrush(next);
    }
  }, []);

  const updateProfile = useCallback((brush: InkBrushId, next: PenProfile) => {
    setProfiles((prev) => ({ ...prev, [brush]: next }));
  }, []);

  const addRecentColor = useCallback((hex: string) => {
    const clean = hex.toUpperCase();
    setRecentColors((prev) =>
      [clean, ...prev.filter((c) => c.toLowerCase() !== clean.toLowerCase())].slice(0, 6),
    );
  }, []);

  return useMemo(
    () => ({
      tool,
      activeBrush,
      profiles,
      recentColors,
      eraserRadius,
      eraserMode,
      selectTool,
      updateProfile,
      addRecentColor,
      setEraserRadius,
      setEraserMode,
    }),
    [tool, activeBrush, profiles, recentColors, eraserRadius, eraserMode, selectTool, updateProfile, addRecentColor],
  );
}

const PREVIEW_POINTS: InkPoint[] = [
  { x: 16, y: 34, p: 0.22, t: 0 },
  { x: 46, y: 18, p: 0.55, t: 25 },
  { x: 86, y: 15, p: 0.92, t: 50 },
  { x: 126, y: 32, p: 0.78, t: 75 },
  { x: 166, y: 40, p: 0.45, t: 100 },
  { x: 204, y: 20, p: 0.2, t: 125 },
];

function PenStrokePreview({ brush, profile }: { brush: InkBrushId; profile: PenProfile }) {
  const rendered = useMemo(() => {
    const stroke: InkStroke = {
      id: 'preview',
      tool: brush,
      color: profile.color,
      width: Math.min(28, profile.width),
      opacity: profile.opacity,
      pressureSensitivity: profile.pressureSensitivity,
      points:
        brush === 'line'
          ? [
              { x: 18, y: 28, p: 0.5, t: 0 },
              { x: 202, y: 28, p: 0.5, t: 100 },
            ]
          : PREVIEW_POINTS,
    };
    return buildStrokeRenderData(stroke, 1, 1);
  }, [brush, profile]);

  return (
    <svg className="ink-preview-svg" viewBox="0 0 220 54" aria-hidden="true">
      {rendered.d &&
        (rendered.mode === 'fill' ? (
          <path d={rendered.d} fill={rendered.color} fillOpacity={rendered.opacity} stroke="none" />
        ) : (
          <path
            d={rendered.d}
            fill="none"
            stroke={rendered.color}
            strokeWidth={rendered.strokeWidth}
            strokeLinecap={rendered.linecap ?? 'round'}
            strokeLinejoin="round"
            strokeOpacity={rendered.opacity}
          />
        ))}
    </svg>
  );
}

export interface FloatingInkToolboxProps {
  open: boolean;
  title?: string;
  session: InkToolSession;
  allowMouse?: boolean;
  showBrowse?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasStrokes: boolean;
  notice?: string;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onDone: () => void;
}

export function FloatingInkToolbox({
  open,
  title = '手写工具',
  session,
  allowMouse = false,
  showBrowse = false,
  canUndo,
  canRedo,
  hasStrokes,
  notice,
  onUndo,
  onRedo,
  onClear,
  onDone,
}: FloatingInkToolboxProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [minimized, setMinimized] = useState(false);
  const [openPopover, setOpenPopover] = useState<'none' | 'pen' | 'color' | 'eraser'>('none');
  const [confirmClear, setConfirmClear] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 16, y: 120 };
    const w = Math.min(540, Math.max(280, window.innerWidth - 24));
    return {
      x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
      y: Math.max(56, window.innerHeight - 168),
    };
  });
  const dragState = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  useEffect(() => {
    if (!open) setOpenPopover('none');
  }, [open]);

  const clampPos = useCallback((x: number, y: number) => {
    if (typeof window === 'undefined') return { x, y };
    const elW = boxRef.current?.offsetWidth || (minimized ? 118 : 340);
    const elH = boxRef.current?.offsetHeight || (minimized ? 44 : 110);
    return {
      x: Math.round(clamp(x, 8, Math.max(8, window.innerWidth - elW - 8))),
      y: Math.round(clamp(y, 8, Math.max(8, window.innerHeight - elH - 8))),
    };
  }, [minimized]);

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPos]);

  useEffect(() => {
    if (open) {
      // Re-clamp slightly after render so expanded/minimized dimensions fit cleanly
      const frame = requestAnimationFrame(() => setPos((p) => clampPos(p.x, p.y)));
      return () => cancelAnimationFrame(frame);
    }
  }, [open, minimized, openPopover, clampPos]);

  const onDragStart = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    dragState.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: pos.x,
      origY: pos.y,
      moved: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onDragMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st || st.pointerId !== e.pointerId) return;
    const dx = e.clientX - st.startClientX;
    const dy = e.clientY - st.startClientY;
    if (Math.hypot(dx, dy) >= 5) st.moved = true;
    if (st.moved) {
      e.preventDefault();
      setPos(clampPos(st.origX + dx, st.origY + dy));
    }
  };

  const onDragEnd = (e: React.PointerEvent, expandOnTap = false) => {
    const st = dragState.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragState.current = null;
    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    if (expandOnTap && !st.moved) {
      setMinimized(false);
    }
  };

  const brushSpec = PEN_BRUSH_SPECS[session.activeBrush];
  const profile = session.profiles[session.activeBrush];
  const quickPalette = session.activeBrush === 'highlight' ? HIGHLIGHT_COLORS : INK_COLORS;
  const mergedSwatches = useMemo(() => {
    const base = [...quickPalette] as string[];
    for (const c of session.recentColors) {
      if (!base.some((x) => x.toLowerCase() === c.toLowerCase())) base.push(c);
    }
    return base.slice(0, 8);
  }, [quickPalette, session.recentColors]);

  const selectColor = (hex: string) => {
    const clean = hex.toUpperCase();
    session.updateProfile(session.activeBrush, { ...profile, color: clean });
    if (session.tool === 'eraser' || session.tool === 'browse') {
      session.selectTool(session.activeBrush);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  const popoverAbove = pos.y > (typeof window !== 'undefined' ? window.innerHeight * 0.45 : 320);

  if (minimized) {
    const activeLabel =
      session.tool === 'eraser'
        ? '橡皮'
        : session.tool === 'browse'
          ? '浏览'
          : brushSpec.label;
    return createPortal(
      <div
        ref={boxRef}
        className="floating-ink-bubble"
        style={{ left: pos.x, top: pos.y }}
        role="region"
        aria-label="手写悬浮球"
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div
          className="floating-ink-bubble-main"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={(e) => onDragEnd(e, true)}
          onPointerCancel={(e) => onDragEnd(e, false)}
          title="拖动位置 · 轻点展开手写工具"
        >
          <span
            className="brush-dot"
            style={{ backgroundColor: session.tool === 'eraser' ? '#D97706' : profile.color }}
          />
          <span>{activeLabel}</span>
          <span className="floating-bubble-expand">展开</span>
        </div>
        <button
          type="button"
          className="floating-bubble-done"
          onClick={onDone}
          title="完成手写"
        >
          完成
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={boxRef}
      className="floating-ink-toolbox"
      style={{ left: pos.x, top: pos.y }}
      role="region"
      aria-label="悬浮手写工具窗"
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div
        className="floating-ink-header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={(e) => onDragEnd(e, false)}
        onPointerCancel={(e) => onDragEnd(e, false)}
      >
        <div className="floating-ink-grip">
          <span className="floating-grip-dots">⋮⋮</span>
          <strong>{title}</strong>
          <span className="floating-ink-hint">
            {allowMouse ? '笔/鼠标 · 长按变橡皮' : '仅笔书写 · 长按变橡皮 · 手指滑页'}
          </span>
        </div>
        <div
          className="floating-ink-win-btns"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ink-btn"
            onClick={() => {
              setOpenPopover('none');
              setMinimized(true);
            }}
            title="缩小为悬浮球"
          >
            缩小
          </button>
          <button
            type="button"
            className="ink-btn primary active"
            onClick={onDone}
          >
            完成
          </button>
        </div>
      </div>

      {notice && <div className="floating-ink-notice">{notice}</div>}

      <div className="ink-tool-strip">
        <div className="ink-tool-group">
          {showBrowse && (
            <button
              type="button"
              className={session.tool === 'browse' ? 'ink-btn active' : 'ink-btn'}
              onClick={() => {
                setOpenPopover('none');
                session.selectTool('browse');
              }}
            >
              浏览
            </button>
          )}
          {PEN_BRUSH_ORDER.map((id) => {
            const spec = PEN_BRUSH_SPECS[id];
            const isSelected = session.tool === id;
            const brushColor = session.profiles[id].color;
            return (
              <button
                key={id}
                type="button"
                className={isSelected ? 'ink-btn ink-brush-btn active' : 'ink-btn ink-brush-btn'}
                title={`${spec.label}：${spec.desc}（再点可调参数）`}
                onClick={() => {
                  if (isSelected) {
                    setOpenPopover((prev) => (prev === 'pen' ? 'none' : 'pen'));
                  } else {
                    session.selectTool(id);
                    setOpenPopover('none');
                  }
                }}
              >
                <span className="brush-dot" style={{ backgroundColor: brushColor }} />
                <span>{spec.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={session.tool === 'eraser' ? 'ink-btn active' : 'ink-btn'}
            title="擦除工具（再点可调大小与模式）"
            onClick={() => {
              if (session.tool === 'eraser') {
                setOpenPopover((prev) => (prev === 'eraser' ? 'none' : 'eraser'));
              } else {
                session.selectTool('eraser');
                setOpenPopover('none');
              }
            }}
          >
            橡皮{session.eraserMode === 'partial' ? '·局部' : '·整笔'}
          </button>
        </div>
      </div>

      <div className="ink-tool-strip floating-ink-row2">
        <div className="ink-tool-group">
          <button
            type="button"
            className={openPopover === 'pen' ? 'ink-btn active' : 'ink-btn'}
            title="调整粗细、压感与透明度"
            onClick={() => setOpenPopover((p) => (p === 'pen' ? 'none' : 'pen'))}
          >
            <span
              className="width-dot-icon"
              style={{
                width: `${Math.max(4, Math.min(13, profile.width * 0.85))}px`,
                height: `${Math.max(4, Math.min(13, profile.width * 0.85))}px`,
                backgroundColor: profile.color,
              }}
            />
            <span>{profile.width.toFixed(1)}</span>
          </button>

          <div className="ink-color-group">
            {mergedSwatches.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`颜色 ${hex}`}
                className={profile.color.toLowerCase() === hex.toLowerCase() ? 'ink-swatch active' : 'ink-swatch'}
                style={{ backgroundColor: hex }}
                onClick={() => selectColor(hex)}
              />
            ))}
            <button
              type="button"
              className={openPopover === 'color' ? 'ink-btn active' : 'ink-btn'}
              onClick={() => setOpenPopover((p) => (p === 'color' ? 'none' : 'color'))}
            >
              调色
            </button>
          </div>
        </div>

        <div className="ink-divider" />

        <div className="ink-tool-group">
          <button type="button" className="ink-btn" disabled={!canUndo} onClick={onUndo}>
            撤销
          </button>
          <button type="button" className="ink-btn" disabled={!canRedo} onClick={onRedo}>
            重做
          </button>
          <button
            type="button"
            className={confirmClear ? 'ink-btn danger active' : 'ink-btn danger'}
            disabled={!hasStrokes}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
              } else {
                setConfirmClear(false);
                onClear();
              }
            }}
          >
            {confirmClear ? '确认清' : '清空'}
          </button>
        </div>
      </div>

      {openPopover !== 'none' && (
        <div
          className={`ink-settings-panel floating-popover ${popoverAbove ? 'pos-above' : 'pos-below'}`}
          role="dialog"
          aria-label="手写参数设置"
        >
          {openPopover === 'pen' && (
            <>
              <div className="ink-settings-head">
                <div>
                  <strong>{brushSpec.label}</strong>
                  <small>{brushSpec.desc}</small>
                </div>
                <button type="button" className="ink-btn" onClick={() => setOpenPopover('none')}>
                  收起
                </button>
              </div>
              <PenStrokePreview brush={session.activeBrush} profile={profile} />
              <div className="ink-presets-row">
                <span className="ink-setting-label">快捷粗细</span>
                <div className="ink-preset-dots">
                  {brushSpec.widthPresets.map((preset) => {
                    const active = Math.abs(profile.width - preset) < 0.25;
                    const dotPx = Math.max(5, Math.min(20, (preset / brushSpec.maxWidth) * 18 + 4));
                    return (
                      <button
                        key={preset}
                        type="button"
                        className={active ? 'ink-preset-btn active' : 'ink-preset-btn'}
                        onClick={() => session.updateProfile(session.activeBrush, { ...profile, width: preset })}
                        title={`${preset}px`}
                      >
                        <span
                          style={{
                            width: `${dotPx}px`,
                            height: `${dotPx}px`,
                            backgroundColor: profile.color,
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="ink-slider-row">
                <span>粗细 · {profile.width.toFixed(1)}</span>
                <input
                  type="range"
                  min={brushSpec.minWidth}
                  max={brushSpec.maxWidth}
                  step={0.2}
                  value={profile.width}
                  onChange={(e) =>
                    session.updateProfile(session.activeBrush, { ...profile, width: Number(e.target.value) })
                  }
                />
              </label>
              {session.activeBrush !== 'line' && session.activeBrush !== 'highlight' && (
                <label className="ink-slider-row">
                  <span>压感笔锋 · {Math.round(profile.pressureSensitivity * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={profile.pressureSensitivity}
                    onChange={(e) =>
                      session.updateProfile(session.activeBrush, {
                        ...profile,
                        pressureSensitivity: Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
              <label className="ink-slider-row">
                <span>不透明度 · {Math.round(profile.opacity * 100)}%</span>
                <input
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={profile.opacity}
                  onChange={(e) =>
                    session.updateProfile(session.activeBrush, { ...profile, opacity: Number(e.target.value) })
                  }
                />
              </label>
            </>
          )}

          {openPopover === 'eraser' && (
            <>
              <div className="ink-settings-head">
                <div>
                  <strong>橡皮擦设置</strong>
                  <small>手写笔在屏幕长按 0.38s 也可临时变橡皮，松开恢复</small>
                </div>
                <button type="button" className="ink-btn" onClick={() => setOpenPopover('none')}>
                  收起
                </button>
              </div>
              <div className="ink-presets-row">
                <span className="ink-setting-label">擦除方式</span>
                <div className="ink-tool-group">
                  <button
                    type="button"
                    className={session.eraserMode === 'partial' ? 'ink-btn primary active' : 'ink-btn'}
                    onClick={() => session.setEraserMode('partial')}
                  >
                    局部擦除（精准）
                  </button>
                  <button
                    type="button"
                    className={session.eraserMode === 'stroke' ? 'ink-btn primary active' : 'ink-btn'}
                    onClick={() => session.setEraserMode('stroke')}
                  >
                    整笔擦除
                  </button>
                </div>
              </div>
              <div className="ink-presets-row">
                <span className="ink-setting-label">橡皮大小</span>
                <div className="ink-preset-dots">
                  {[10, 16, 26, 40].map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={Math.abs(session.eraserRadius - r) < 2 ? 'ink-btn active' : 'ink-btn'}
                      onClick={() => session.setEraserRadius(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <label className="ink-slider-row">
                <span>半径 · {session.eraserRadius}px</span>
                <input
                  type="range"
                  min={6}
                  max={56}
                  step={2}
                  value={session.eraserRadius}
                  onChange={(e) => session.setEraserRadius(Number(e.target.value))}
                />
              </label>
            </>
          )}

          {openPopover === 'color' && (
            <>
              <div className="ink-settings-head">
                <strong>选择墨迹颜色 · {brushSpec.label}</strong>
                <button type="button" className="ink-btn" onClick={() => setOpenPopover('none')}>
                  收起
                </button>
              </div>
              <div className="ink-palette-grid">
                {EXTENDED_INK_COLORS.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`选择颜色 ${hex}`}
                    className={
                      profile.color.toLowerCase() === hex.toLowerCase()
                        ? 'ink-palette-cell active'
                        : 'ink-palette-cell'
                    }
                    style={{ backgroundColor: hex }}
                    onClick={() => {
                      selectColor(hex);
                      session.addRecentColor(hex);
                    }}
                  />
                ))}
              </div>
              <div className="ink-custom-color-row">
                <label className="ink-custom-color-picker">
                  <span>自定义颜色</span>
                  <input
                    type="color"
                    value={profile.color}
                    onChange={(e) => {
                      selectColor(e.target.value);
                      session.addRecentColor(e.target.value);
                    }}
                  />
                  <code>{profile.color.toUpperCase()}</code>
                </label>
              </div>
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

/* ===========================
 * High-FPS Dual-Layer Canvas for Persistent Handwriting Pads
 * =========================== */

interface PadCanvasProps {
  pad: HandwritingPad;
  writing: boolean;
  session: InkToolSession;
  allowMouse: boolean;
  onActivateWriting: () => void;
  onCommitStrokes: (nextStrokes: InkStroke[], recordHistory?: boolean) => void;
}

function PadCanvas({
  pad,
  writing,
  session,
  allowMouse,
  onActivateWriting,
  onCommitStrokes,
}: PadCanvasProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const committedCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);

  const activeStroke = useRef<InkStroke | null>(null);
  const workingStrokes = useRef<InkStroke[] | null>(null);
  const eraseDirty = useRef(false);
  const lastErasePt = useRef<{ x: number; y: number } | null>(null);
  const hoverCursor = useRef<{ x: number; y: number } | null>(null);
  const activePointer = useRef<number | null>(null);
  const activePointerType = useRef<string>('pen');
  const activePenDown = useRef(false);
  const activeMode = useRef<'draw' | 'erase'>('draw');
  const isLongPressErase = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ x: number; y: number; pt: InkPoint } | null>(null);
  const strokeStartMs = useRef<number>(0);
  const lastPenEventWall = useRef<number>(0);
  const cachedRect = useRef<DOMRect | null>(null);
  const canvasSize = useRef<{ cssW: number; cssH: number }>({ cssW: 320, cssH: 150 });

  const latestPad = useRef(pad);
  latestPad.current = pad;
  const latestSession = useRef(session);
  latestSession.current = session;
  const latestWriting = useRef(writing);
  latestWriting.current = writing;
  const latestOnActivateWriting = useRef(onActivateWriting);
  latestOnActivateWriting.current = onActivateWriting;
  const latestOnCommitStrokes = useRef(onCommitStrokes);
  latestOnCommitStrokes.current = onCommitStrokes;

  const paintCommitted = useCallback((strokes: readonly InkStroke[]) => {
    const canvas = committedCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const h = Math.max(1, latestPad.current.logicalHeight);
    ctx.setTransform(canvas.width / 1000, 0, 0, canvas.height / h, 0, 0);
    for (let i = 0; i < strokes.length; i++) {
      drawStrokeToCanvas(ctx, strokes[i], 1, 1, true);
    }
  }, []);

  const paintLive = useCallback(
    (
      stroke: InkStroke | null,
      predictedPts: InkPoint[] = [],
      cursor: { x: number; y: number; r: number; longPress: boolean } | null = null,
    ) => {
      const canvas = liveCanvasRef.current;
      const cCanvas = committedCanvasRef.current;
      if (!canvas) return;
      if (!stroke && !cursor) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        return;
      }
      // Lazily allocate live canvas backing buffer to match committed canvas when actually drawing
      if (cCanvas && cCanvas.width > 1 && cCanvas.height > 1) {
        if (canvas.width !== cCanvas.width || canvas.height !== cCanvas.height) {
          canvas.width = cCanvas.width;
          canvas.height = cCanvas.height;
        }
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const h = Math.max(1, latestPad.current.logicalHeight);
      ctx.setTransform(canvas.width / 1000, 0, 0, canvas.height / h, 0, 0);
      if (stroke && stroke.points.length > 0) {
        const displayStroke =
          predictedPts.length > 0 ? { ...stroke, points: [...stroke.points, ...predictedPts] } : stroke;
        drawStrokeToCanvas(ctx, displayStroke, 1, 1, false);
      }
      if (cursor) {
        drawEraserCursor(ctx, cursor.x, cursor.y, cursor.r, cursor.longPress);
      }
    },
    [],
  );

  const syncCanvasResolution = useCallback(() => {
    const box = boxRef.current;
    const cCanvas = committedCanvasRef.current;
    const lCanvas = liveCanvasRef.current;
    if (!box || !cCanvas || !lCanvas) return;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    cachedRect.current = rect;
    canvasSize.current = { cssW: rect.width, cssH: rect.height };
    const maxDim = Math.max(rect.width, rect.height, 1);
    // Cap DPR at 1.75 / max 2560px to stay razor-sharp while avoiding Android WebView GPU canvas OOM
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75, 2560 / maxDim);
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (cCanvas.width !== bw || cCanvas.height !== bh) {
      cCanvas.width = bw;
      cCanvas.height = bh;
    }
    const needLiveBuffer =
      latestWriting.current || activePointer.current !== null || hoverCursor.current !== null;
    if (needLiveBuffer) {
      if (lCanvas.width !== bw || lCanvas.height !== bh) {
        lCanvas.width = bw;
        lCanvas.height = bh;
      }
    } else if (lCanvas.width !== 1 || lCanvas.height !== 1) {
      lCanvas.width = 1;
      lCanvas.height = 1;
    }
    paintCommitted(workingStrokes.current ?? latestPad.current.strokes);
    if (activeStroke.current) {
      paintLive(activeStroke.current);
    }
  }, [paintCommitted, paintLive]);

  useEffect(() => {
    syncCanvasResolution();
    const box = boxRef.current;
    const cCanvas = committedCanvasRef.current;
    const onContextRestored = () => {
      paintCommitted(workingStrokes.current ?? latestPad.current.strokes);
    };
    cCanvas?.addEventListener('contextrestored', onContextRestored);
    if (!box || typeof ResizeObserver === 'undefined') {
      return () => cCanvas?.removeEventListener('contextrestored', onContextRestored);
    }
    const ro = new ResizeObserver(syncCanvasResolution);
    ro.observe(box);
    return () => {
      ro.disconnect();
      cCanvas?.removeEventListener('contextrestored', onContextRestored);
    };
  }, [syncCanvasResolution, paintCommitted, pad.logicalHeight, writing]);

  useEffect(() => {
    if (!workingStrokes.current) {
      paintCommitted(pad.strokes);
    }
  }, [pad.strokes, paintCommitted]);

  const toLogicalPoint = useCallback(
    (
      clientX: number,
      clientY: number,
      pressure: number,
      timeStamp: number,
      rectOverride?: DOMRect | null,
    ): InkPoint | null => {
      const rect = rectOverride ?? boxRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      const x = clamp((clientX - rect.left) / rect.width, 0, 1) * 1000;
      const y = clamp((clientY - rect.top) / rect.height, 0, 1) * latestPad.current.logicalHeight;
      return {
        x: roundLogical(x),
        y: roundLogical(y),
        p: Math.round(pressure * 100) / 100,
        t: Math.max(0, Math.round(timeStamp - strokeStartMs.current)),
      };
    },
    [],
  );

  const getLogicalEraserRadius = useCallback((rect?: DOMRect | null): number => {
    const w = rect?.width || canvasSize.current.cssW || 360;
    return latestSession.current.eraserRadius * (1000 / Math.max(1, w));
  }, []);

  const applyEraseSegment = useCallback(
    (ax: number, ay: number, bx: number, by: number, rLogical: number) => {
      const current = workingStrokes.current ?? latestPad.current.strokes;
      if (latestSession.current.eraserMode === 'stroke') {
        const next = current.filter(
          (s) => !hitTestStroke(s, bx, by, rLogical, 1, 1) && !hitTestStroke(s, ax, ay, rLogical, 1, 1),
        );
        if (next.length !== current.length) {
          workingStrokes.current = next;
          eraseDirty.current = true;
          paintCommitted(next);
        }
        return;
      }

      const { strokes: next, changed } = eraseStrokesAtSegment(
        current,
        ax,
        ay,
        bx,
        by,
        rLogical,
        1,
        1,
        () => nextId('st'),
      );
      if (changed) {
        workingStrokes.current = next;
        eraseDirty.current = true;
        paintCommitted(next);
      }
    },
    [paintCommitted],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  }, []);

  const finishStroke = useCallback(
    (pointerId: number, canceled: boolean) => {
      cancelLongPress();
      if (activePointer.current !== pointerId) return;
      activePointer.current = null;
      activePenDown.current = false;

      if (activeMode.current === 'erase') {
        const modified = eraseDirty.current && workingStrokes.current !== null;
        const committed = workingStrokes.current;
        workingStrokes.current = null;
        eraseDirty.current = false;
        lastErasePt.current = null;
        isLongPressErase.current = false;
        paintLive(null);
        if (!canceled && modified && committed) {
          latestOnCommitStrokes.current(committed, true);
        } else {
          paintCommitted(latestPad.current.strokes);
        }
        return;
      }

      const done = activeStroke.current;
      activeStroke.current = null;
      paintLive(null);
      if (!canceled && done && done.points.length > 0) {
        latestOnCommitStrokes.current([...latestPad.current.strokes, done], true);
      }
    },
    [cancelLongPress, paintCommitted, paintLive],
  );

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const detachActiveWindowListeners = () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerCancel);
    };

    const forceResetPadStroke = () => {
      detachActiveWindowListeners();
      activePenDown.current = false;
      if (activePointer.current !== null) {
        finishStroke(activePointer.current, true);
      } else {
        cancelLongPress();
        hoverCursor.current = null;
        paintLive(null);
      }
    };

    const onWindowPointerMove = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      lastPenEventWall.current = Date.now();
      e.preventDefault();

      // Always read fresh bounding rect so strokes stay exact even right after smooth scrolling
      const rect = box.getBoundingClientRect();
      cachedRect.current = rect;
      const extEvt = e as PointerEvent & { getPredictedEvents?: () => PointerEvent[] };
      const samples = typeof extEvt.getCoalescedEvents === 'function' ? extEvt.getCoalescedEvents() : [];
      const events = samples.length > 0 ? samples : [extEvt];

      if (activeMode.current === 'erase') {
        const rLogical = getLogicalEraserRadius(rect);
        let latestPt: InkPoint | null = null;
        for (const ev of events) {
          const pt = toLogicalPoint(ev.clientX, ev.clientY, ev.pressure || 0.5, ev.timeStamp || Date.now(), rect);
          if (!pt) continue;
          const prev = lastErasePt.current ?? { x: pt.x, y: pt.y };
          applyEraseSegment(prev.x, prev.y, pt.x, pt.y, rLogical);
          lastErasePt.current = { x: pt.x, y: pt.y };
          latestPt = pt;
        }
        if (latestPt) {
          paintLive(null, [], {
            x: latestPt.x,
            y: latestPt.y,
            r: rLogical,
            longPress: isLongPressErase.current,
          });
        }
        return;
      }

      if (longPressStart.current) {
        if (Math.hypot(e.clientX - longPressStart.current.x, e.clientY - longPressStart.current.y) > 7) {
          cancelLongPress();
        }
      }

      const cur = activeStroke.current;
      if (!cur) return;
      for (const ev of events) {
        const pt = toLogicalPoint(ev.clientX, ev.clientY, ev.pressure || 0.5, ev.timeStamp || Date.now(), rect);
        if (!pt) continue;
        if (cur.tool === 'line') {
          cur.points = [cur.points[0], snapLinePoint(cur.points[0], pt, 1, 1)];
        } else {
          cur.points = appendPointFiltered(cur.points, pt, 0.6, 1, 1, 2000);
        }
        if (longPressStart.current) longPressStart.current.pt = pt;
      }

      const predictedPts: InkPoint[] = [];
      if (cur.tool !== 'line' && typeof extEvt.getPredictedEvents === 'function') {
        const predicted = extEvt.getPredictedEvents();
        for (let i = 0; i < Math.min(2, predicted.length); i++) {
          const pev = predicted[i];
          const ppt = toLogicalPoint(
            pev.clientX,
            pev.clientY,
            cur.points[cur.points.length - 1]?.p ?? 0.5,
            pev.timeStamp || Date.now(),
            rect,
          );
          if (ppt) predictedPts.push(ppt);
        }
      }
      paintLive(cur, predictedPts);
    };

    const onWindowPointerUp = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      detachActiveWindowListeners();
      finishStroke(e.pointerId, false);
    };

    const onWindowPointerCancel = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      detachActiveWindowListeners();
      // Preserve strokes/erases that already have meaningful user input instead of discarding them
      const hasDrawnWork =
        activeMode.current === 'erase'
          ? eraseDirty.current
          : (activeStroke.current?.points.length ?? 0) >= 2;
      finishStroke(e.pointerId, !hasDrawnWork);
    };

    const onBoxPointerDown = (e: PointerEvent) => {
      // Touch fingers NEVER draw and NEVER intercept — clear any non-active pen flag BEFORE touchstart
      if (e.pointerType === 'touch') {
        const penActivelyDrawing =
          activePointer.current !== null &&
          activePointerType.current === 'pen' &&
          Date.now() - lastPenEventWall.current < 250;
        if (!penActivelyDrawing) {
          activePenDown.current = false;
          if (activePointer.current !== null) {
            detachActiveWindowListeners();
            finishStroke(activePointer.current, false);
          }
        }
        return;
      }
      if (!canWriteWithPointer(e, allowMouse)) return;
      if (e.pointerType === 'mouse' && !latestWriting.current) return;

      if (activePointer.current !== null) {
        detachActiveWindowListeners();
        finishStroke(activePointer.current, false);
      }

      const rect = box.getBoundingClientRect();
      strokeStartMs.current = e.timeStamp || Date.now();
      const pt = toLogicalPoint(e.clientX, e.clientY, e.pressure || 0.5, strokeStartMs.current, rect);
      if (!pt) return;

      e.preventDefault();
      e.stopPropagation();

      if (!latestWriting.current) latestOnActivateWriting.current();

      cachedRect.current = rect;
      lastPenEventWall.current = Date.now();
      activePenDown.current = e.pointerType === 'pen';
      activePointer.current = e.pointerId;
      activePointerType.current = e.pointerType;

      window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerCancel);

      const s = latestSession.current;
      const rLogical = getLogicalEraserRadius(rect);
      if (s.tool === 'eraser' || isStylusEraser(e)) {
        activeMode.current = 'erase';
        isLongPressErase.current = false;
        workingStrokes.current = [...latestPad.current.strokes];
        eraseDirty.current = false;
        lastErasePt.current = { x: pt.x, y: pt.y };
        applyEraseSegment(pt.x, pt.y, pt.x, pt.y, rLogical);
        paintLive(null, [], { x: pt.x, y: pt.y, r: rLogical, longPress: false });
        return;
      }

      activeMode.current = 'draw';
      isLongPressErase.current = false;
      const brush = s.activeBrush;
      const prof = s.profiles[brush];
      const created: InkStroke = {
        id: nextId('st'),
        tool: brush,
        color: prof.color,
        width: prof.width,
        opacity: prof.opacity,
        pressureSensitivity: prof.pressureSensitivity,
        points: [pt],
      };
      activeStroke.current = created;
      paintLive(created);

      // S-Pen long-press switches to partial eraser while held, restores pen on release
      if (e.pointerType === 'pen' && brush !== 'line') {
        cancelLongPress();
        longPressStart.current = { x: e.clientX, y: e.clientY, pt };
        const pid = e.pointerId;
        longPressTimer.current = window.setTimeout(() => {
          longPressTimer.current = null;
          if (activePointer.current !== pid || !longPressStart.current) return;
          const holdPt = longPressStart.current.pt;
          longPressStart.current = null;
          activeStroke.current = null;
          activeMode.current = 'erase';
          isLongPressErase.current = true;
          workingStrokes.current = [...latestPad.current.strokes];
          eraseDirty.current = false;
          lastErasePt.current = { x: holdPt.x, y: holdPt.y };
          triggerLightHaptic();
          const radiusNow = getLogicalEraserRadius(cachedRect.current);
          applyEraseSegment(holdPt.x, holdPt.y, holdPt.x, holdPt.y, radiusNow);
          paintLive(null, [], { x: holdPt.x, y: holdPt.y, r: radiusNow, longPress: true });
        }, 380);
      }
    };

    const onBoxPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || activePointer.current !== null) return;
      if (e.pointerType === 'pen' && (latestSession.current.tool === 'eraser' || isStylusEraser(e))) {
        const rect = box.getBoundingClientRect();
        cachedRect.current = rect;
        const pt = toLogicalPoint(e.clientX, e.clientY, 0.5, e.timeStamp || Date.now(), rect);
        if (pt) {
          hoverCursor.current = { x: pt.x, y: pt.y };
          paintLive(null, [], {
            x: pt.x,
            y: pt.y,
            r: getLogicalEraserRadius(rect),
            longPress: false,
          });
        }
      } else if (hoverCursor.current) {
        hoverCursor.current = null;
        paintLive(null);
      }
    };

    const onBoxPointerLeave = () => {
      if (hoverCursor.current) {
        hoverCursor.current = null;
        if (activePointer.current === null) paintLive(null);
      }
    };

    // In Chromium Android WebView, pointerdown (with pointerType === 'pen' vs 'touch') fires
    // synchronously BEFORE touchstart, while Touch.touchType is undefined. Suppress scroll ONLY
    // when an S-Pen contact was just recognized, keeping finger scrolling 100% native.
    const isPadPenTouchActive = (e: TouchEvent): boolean =>
      touchEventHasStylus(e) ||
      activePenDown.current ||
      (activePointer.current !== null &&
        activePointerType.current === 'pen' &&
        Date.now() - lastPenEventWall.current < 1500);

    const onBoxTouchStartCapture = (e: TouchEvent) => {
      if (isPadPenTouchActive(e)) {
        e.preventDefault();
      }
    };

    const onBoxTouchMoveCapture = (e: TouchEvent) => {
      if (isPadPenTouchActive(e)) {
        e.preventDefault();
      }
    };

    const onWindowTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        if (Date.now() - lastPenEventWall.current > 120) {
          activePenDown.current = false;
          if (activePointer.current !== null && activePointerType.current === 'pen') {
            detachActiveWindowListeners();
            finishStroke(activePointer.current, false);
          }
        }
      }
    };

    const onBoxContextMenu = (e: MouseEvent) => {
      if (activePointer.current !== null || Date.now() - lastPenEventWall.current < 500) {
        e.preventDefault();
      }
    };

    box.addEventListener('pointerdown', onBoxPointerDown, { capture: true });
    box.addEventListener('pointermove', onBoxPointerMove);
    box.addEventListener('pointerleave', onBoxPointerLeave);
    box.addEventListener('touchstart', onBoxTouchStartCapture, { capture: true, passive: false });
    box.addEventListener('touchmove', onBoxTouchMoveCapture, { capture: true, passive: false });
    box.addEventListener('contextmenu', onBoxContextMenu);
    window.addEventListener('touchend', onWindowTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onWindowTouchEnd, { passive: true });
    window.addEventListener('blur', forceResetPadStroke);
    document.addEventListener('visibilitychange', forceResetPadStroke);

    return () => {
      forceResetPadStroke();
      box.removeEventListener('pointerdown', onBoxPointerDown, { capture: true });
      box.removeEventListener('pointermove', onBoxPointerMove);
      box.removeEventListener('pointerleave', onBoxPointerLeave);
      box.removeEventListener('touchstart', onBoxTouchStartCapture, { capture: true });
      box.removeEventListener('touchmove', onBoxTouchMoveCapture, { capture: true });
      box.removeEventListener('contextmenu', onBoxContextMenu);
      window.removeEventListener('touchend', onWindowTouchEnd);
      window.removeEventListener('touchcancel', onWindowTouchEnd);
      window.removeEventListener('blur', forceResetPadStroke);
      document.removeEventListener('visibilitychange', forceResetPadStroke);
    };
  }, [
    allowMouse,
    applyEraseSegment,
    cancelLongPress,
    finishStroke,
    getLogicalEraserRadius,
    paintLive,
    toLogicalPoint,
  ]);

  return (
    <div
      ref={boxRef}
      className={`pad-canvas-box pad-bg-${pad.background} ${writing ? 'is-writing' : ''} ${allowMouse && writing ? 'allow-mouse-writing' : ''}`}
      style={{ aspectRatio: `1000 / ${pad.logicalHeight}` }}
    >
      <canvas ref={committedCanvasRef} className="pad-canvas-layer" />
      <canvas ref={liveCanvasRef} className="pad-canvas-layer pad-canvas-live" />
      {pad.strokes.length === 0 && !writing && (
        <div className="pad-empty-hint">
          <span>{allowMouse ? '点击「书写」后用鼠标或触控笔书写' : '手写笔直接落笔书写，长按擦除 · 手指滑页'}</span>
        </div>
      )}
    </div>
  );
}

/* ===========================
 * Persistent Handwriting Pad Card
 * =========================== */

export interface ActivePadControl {
  canUndo: boolean;
  canRedo: boolean;
  hasStrokes: boolean;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  finish: () => void;
}

export interface HandwritingPadCardProps {
  pad: HandwritingPad;
  headings: InkHeadingRef[];
  orphaned?: boolean;
  autoFocus?: boolean;
  allowMouse?: boolean;
  active?: boolean;
  session: InkToolSession;
  onActivate?: (padId: string, ctrl: ActivePadControl) => void;
  onDeactivate?: (padId: string) => void;
  onChange: (updated: HandwritingPad) => void;
  onDelete: (id: string) => void;
  onRequestMove?: (id: string) => void;
}

export function HandwritingPadCard({
  pad,
  headings,
  orphaned = false,
  autoFocus = false,
  allowMouse = false,
  active,
  session,
  onActivate,
  onDeactivate,
  onChange,
  onDelete,
  onRequestMove,
}: HandwritingPadCardProps) {
  const [localWriting, setLocalWriting] = useState(autoFocus);
  const writing = active !== undefined ? active : localWriting;
  const [menuOpen, setMenuOpen] = useState(autoFocus);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenZoom, setFullscreenZoom] = useState(1);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(pad.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [undoStack, setUndoStack] = useState<InkStroke[][]>([]);
  const [redoStack, setRedoStack] = useState<InkStroke[][]>([]);
  const dragStart = useRef<{ y: number; height: number } | null>(null);

  const latestPad = useRef(pad);
  latestPad.current = pad;

  useEffect(() => {
    setTitleDraft(pad.title);
  }, [pad.title]);

  useEffect(() => {
    if (autoFocus) setMenuOpen(true);
  }, [autoFocus]);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const commitStrokes = useCallback(
    (nextStrokes: InkStroke[], recordHistory = true) => {
      const cur = latestPad.current;
      if (recordHistory) {
        setUndoStack((prev) => [...prev.slice(-29), cur.strokes]);
        setRedoStack([]);
      }
      onChange({
        ...cur,
        strokes: nextStrokes,
        updatedAt: Date.now(),
      });
    },
    [onChange],
  );

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1];
      const cur = latestPad.current;
      setRedoStack((r) => [...r.slice(-29), cur.strokes]);
      onChange({ ...cur, strokes: previous, updatedAt: Date.now() });
      return prev.slice(0, -1);
    });
  }, [onChange]);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      const cur = latestPad.current;
      setUndoStack((u) => [...u.slice(-29), cur.strokes]);
      onChange({ ...cur, strokes: restored, updatedAt: Date.now() });
      return prev.slice(0, -1);
    });
  }, [onChange]);

  const handleFinish = useCallback(() => {
    setMenuOpen(false);
    setFullscreen(false);
    setLocalWriting(false);
    onDeactivate?.(latestPad.current.id);
  }, [onDeactivate]);

  const activateWriting = useCallback(() => {
    setLocalWriting(true);
    onActivate?.(latestPad.current.id, {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      hasStrokes: latestPad.current.strokes.length > 0,
      undo: handleUndo,
      redo: handleRedo,
      clear: () => commitStrokes([], true),
      finish: handleFinish,
    });
  }, [onActivate, undoStack.length, redoStack.length, handleUndo, handleRedo, commitStrokes, handleFinish]);

  // Keep active controller fresh while this pad is active
  useEffect(() => {
    if (writing && onActivate) {
      onActivate(pad.id, {
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        hasStrokes: pad.strokes.length > 0,
        undo: handleUndo,
        redo: handleRedo,
        clear: () => commitStrokes([], true),
        finish: handleFinish,
      });
    }
  }, [writing, pad.id, pad.strokes.length, undoStack.length, redoStack.length, onActivate, handleUndo, handleRedo, commitStrokes, handleFinish]);

  const anchorLabel = useMemo(() => {
    if (orphaned) return '原位置已变更';
    if (pad.anchorType === 'top') return '笔记顶部';
    if (pad.anchorType === 'bottom') return '笔记末尾';
    if (pad.anchorType === 'block') {
      const snippet = (pad.anchorBlockText ?? '').trim();
      if (snippet) return `行后：${snippet.slice(0, 14)}${snippet.length > 14 ? '…' : ''}`;
      if (typeof pad.anchorBlockIndex === 'number') return `第 ${pad.anchorBlockIndex + 1} 段后`;
      return '行内锚定';
    }
    return pad.anchorHeadingText ? `节：${pad.anchorHeadingText.slice(0, 14)}` : '小节后';
  }, [orphaned, pad.anchorType, pad.anchorBlockText, pad.anchorBlockIndex, pad.anchorHeadingText]);

  const anchorValue =
    pad.anchorType === 'top'
      ? '__top__'
      : pad.anchorType === 'bottom'
        ? '__bottom__'
        : pad.anchorType === 'heading' && pad.anchorHeadingId
          ? `h:${pad.anchorHeadingId}`
          : '__custom__';

  const handleAnchorChange = (value: string) => {
    if (value === '__top__') {
      onChange({ ...pad, anchorType: 'top', anchorHeadingId: '', anchorHeadingText: '', updatedAt: Date.now() });
    } else if (value === '__bottom__') {
      onChange({ ...pad, anchorType: 'bottom', anchorHeadingId: '', anchorHeadingText: '', updatedAt: Date.now() });
    } else if (value.startsWith('h:')) {
      const id = value.slice(2);
      const target = headings.find((h) => h.id === id);
      if (target) {
        onChange({
          ...pad,
          anchorType: 'heading',
          anchorHeadingId: target.id,
          anchorHeadingText: target.text,
          updatedAt: Date.now(),
        });
      }
    }
  };

  const nextBackground = () => {
    const idx = PAD_BACKGROUNDS.findIndex((b) => b.id === pad.background);
    const next = PAD_BACKGROUNDS[(idx + 1) % PAD_BACKGROUNDS.length];
    onChange({ ...pad, background: next.id, updatedAt: Date.now() });
  };

  const bgLabel = PAD_BACKGROUNDS.find((b) => b.id === pad.background)?.label ?? '白纸';

  return (
    <section
      id={`pad-${pad.id}`}
      className={`handwriting-pad ${writing ? 'writing' : ''} ${orphaned ? 'orphaned' : ''} ${!menuOpen && !pad.collapsed ? 'clean-mode' : ''}`}
      data-pad-id={pad.id}
    >
      {pad.collapsed ? (
        <div className="pad-collapsed-bar">
          <span className="pad-badge">手写栏</span>
          <span className="pad-collapsed-title">{pad.title}</span>
          <span className="pad-count">{pad.strokes.length} 笔</span>
          <button
            type="button"
            className="ink-btn"
            onClick={() => onChange({ ...pad, collapsed: false, updatedAt: Date.now() })}
          >
            展开
          </button>
        </div>
      ) : (
        <>
          {menuOpen && (
            <div className="pad-header">
              <div className="pad-title-row">
                <span className="pad-badge">手写栏</span>
                {editingTitle ? (
                  <input
                    className="pad-title-input"
                    value={titleDraft}
                    autoFocus
                    maxLength={80}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => {
                      setEditingTitle(false);
                      const clean = titleDraft.trim() || '手写笔记';
                      if (clean !== pad.title) onChange({ ...pad, title: clean, updatedAt: Date.now() });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="pad-title-btn"
                    onClick={() => setEditingTitle(true)}
                    title="点击修改手写栏标题"
                  >
                    {pad.title}
                  </button>
                )}
                <span className="pad-count">{pad.strokes.length} 笔</span>
              </div>

              <div className="pad-actions">
                {onRequestMove ? (
                  <button
                    type="button"
                    className="ink-btn"
                    title={`当前位置：${anchorLabel}，点击重新选择任意行`}
                    onClick={() => onRequestMove(pad.id)}
                  >
                    移动 · {anchorLabel}
                  </button>
                ) : (
                  <select
                    className="pad-anchor-select"
                    aria-label="手写栏锚点位置"
                    value={anchorValue}
                    onChange={(e) => handleAnchorChange(e.target.value)}
                  >
                    {anchorValue === '__custom__' && (
                      <option value="__custom__" disabled>
                        位置：{anchorLabel}
                      </option>
                    )}
                    <option value="__top__">位置：笔记顶部</option>
                    {headings.map((h) => (
                      <option key={h.id} value={`h:${h.id}`}>
                        {'　'.repeat(Math.max(0, h.depth - 1)) + h.text.slice(0, 48)}
                      </option>
                    ))}
                    <option value="__bottom__">位置：笔记末尾</option>
                  </select>
                )}

                <button type="button" className="ink-btn" onClick={nextBackground}>
                  {bgLabel}
                </button>

                {!writing ? (
                  <button type="button" className="ink-btn primary" onClick={activateWriting}>
                    书写
                  </button>
                ) : null}

                <button
                  type="button"
                  className="ink-btn"
                  onClick={() => {
                    activateWriting();
                    setFullscreen(true);
                  }}
                >
                  放大
                </button>

                <button
                  type="button"
                  className="ink-btn"
                  onClick={() => {
                    onDeactivate?.(pad.id);
                    onChange({ ...pad, collapsed: true, updatedAt: Date.now() });
                  }}
                >
                  折叠
                </button>

                <button
                  type="button"
                  className={confirmDelete ? 'ink-btn danger active' : 'ink-btn danger'}
                  onClick={() => {
                    if (!confirmDelete) setConfirmDelete(true);
                    else {
                      onDeactivate?.(pad.id);
                      onDelete(pad.id);
                    }
                  }}
                >
                  {confirmDelete ? '确认删' : '删除'}
                </button>

                <button
                  type="button"
                  className="ink-btn"
                  onClick={() => setMenuOpen(false)}
                  title="仅折叠此栏菜单，不退出书写"
                >
                  收起菜单
                </button>

                <button
                  type="button"
                  className="ink-btn primary active"
                  onClick={handleFinish}
                  title="完成编辑并自动隐藏手写栏菜单"
                >
                  确定
                </button>
              </div>
            </div>
          )}

          {orphaned && (
            <div className="pad-orphan-banner">
              原锚定位置「{pad.anchorBlockText || pad.anchorHeadingText || '已变更'}」未匹配，手写墨迹已安全保留。
            </div>
          )}

          <div className="pad-stage-wrap">
            {!menuOpen && (
              <div className="pad-corner-controls">
                {writing && (
                  <button
                    type="button"
                    className="pad-corner-pill primary"
                    onClick={handleFinish}
                  >
                    完成
                  </button>
                )}
                <button
                  type="button"
                  className="pad-corner-pill"
                  onClick={() => setMenuOpen(true)}
                  title={`展开「${pad.title}」菜单`}
                >
                  ⋯ 菜单
                </button>
              </div>
            )}

            <PadCanvas
              pad={pad}
              writing={writing}
              session={session}
              allowMouse={allowMouse}
              onActivateWriting={activateWriting}
              onCommitStrokes={commitStrokes}
            />
          </div>

          {menuOpen && (
            <div className="pad-resize-bar">
              <div
                className="pad-resize-grip"
                onPointerDown={(e) => {
                  e.preventDefault();
                  dragStart.current = { y: e.clientY, height: pad.logicalHeight };
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!dragStart.current) return;
                  const dy = e.clientY - dragStart.current.y;
                  const nextHeight = Math.round(Math.max(220, Math.min(2400, dragStart.current.height + dy * 1.4)));
                  if (nextHeight !== pad.logicalHeight) {
                    onChange({ ...pad, logicalHeight: nextHeight, updatedAt: Date.now() });
                  }
                }}
                onPointerUp={() => {
                  dragStart.current = null;
                }}
                onPointerCancel={() => {
                  dragStart.current = null;
                }}
              >
                <span>拖拽调整高度（{pad.logicalHeight}）</span>
              </div>
              <div className="pad-height-btns">
                <button
                  type="button"
                  className="ink-btn"
                  onClick={() =>
                    onChange({ ...pad, logicalHeight: Math.max(220, pad.logicalHeight - 160), updatedAt: Date.now() })
                  }
                >
                  - 减高
                </button>
                <button
                  type="button"
                  className="ink-btn"
                  onClick={() =>
                    onChange({ ...pad, logicalHeight: Math.min(2400, pad.logicalHeight + 200), updatedAt: Date.now() })
                  }
                >
                  + 加高
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {fullscreen &&
        createPortal(
          <div className="pad-fullscreen-modal" role="dialog" aria-modal="true" aria-label={`全屏手写：${pad.title}`}>
            <div className="pad-fullscreen-header">
              <strong>{pad.title}</strong>
              <div className="pad-actions">
                <button
                  type="button"
                  className="ink-btn"
                  onClick={() => setFullscreenZoom((z) => Math.max(0.75, Math.round((z - 0.15) * 100) / 100))}
                >
                  -
                </button>
                <span className="pad-count">{Math.round(fullscreenZoom * 100)}%</span>
                <button
                  type="button"
                  className="ink-btn"
                  onClick={() => setFullscreenZoom((z) => Math.min(1.6, Math.round((z + 0.15) * 100) / 100))}
                >
                  +
                </button>
                <button type="button" className="ink-btn" onClick={nextBackground}>
                  {bgLabel}
                </button>
                <button
                  type="button"
                  className="ink-btn"
                  onClick={() =>
                    onChange({ ...pad, logicalHeight: Math.min(2400, pad.logicalHeight + 220), updatedAt: Date.now() })
                  }
                >
                  + 加高
                </button>
                <button type="button" className="ink-btn primary active" onClick={() => setFullscreen(false)}>
                  退出放大
                </button>
              </div>
            </div>
            <div className="pad-fullscreen-scroll">
              <div className="pad-fullscreen-stage" style={{ width: `${Math.round(fullscreenZoom * 100)}%` }}>
                <PadCanvas
                  pad={pad}
                  writing={true}
                  session={session}
                  allowMouse={allowMouse}
                  onActivateWriting={activateWriting}
                  onCommitStrokes={commitStrokes}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}

/* ===========================
 * Compositor-Locked Tiled Canvas + Stylus-Only Capture for Temp Overlay Ink
 * =========================== */

const TEMP_TILE_HEIGHT = 768;
const TEMP_LIVE_SLICE_HEIGHT = 960;

interface TempInkTileProps {
  tileIndex: number;
  width: number;
  strokes: readonly InkStroke[];
  registerDrawer: (tileIndex: number, fn: ((list: readonly InkStroke[]) => void) | null) => void;
}

const TempInkTileCanvas = React.memo(function TempInkTileCanvas({
  tileIndex,
  width,
  strokes,
  registerDrawer,
}: TempInkTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestStrokes = useRef(strokes);
  latestStrokes.current = strokes;
  const latestWidth = useRef(width);
  latestWidth.current = width;

  const draw = useCallback(
    (list: readonly InkStroke[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = Math.max(1, latestWidth.current);
      const tileTop = tileIndex * TEMP_TILE_HEIGHT;
      const minY = tileTop - 28;
      const maxY = tileTop + TEMP_TILE_HEIGHT + 28;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / w, 0, 0, canvas.height / TEMP_TILE_HEIGHT, 0, 0);
      ctx.translate(0, -tileTop);

      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        const bounds = getStrokeBoundingBox(st, w, 1);
        if (bounds && (bounds.maxY < minY || bounds.minY > maxY)) continue;
        drawStrokeToCanvas(ctx, st, w, 1, true);
      }
    },
    [tileIndex],
  );

  useEffect(() => {
    registerDrawer(tileIndex, draw);
    return () => registerDrawer(tileIndex, null);
  }, [tileIndex, draw, registerDrawer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.max(200, width);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75, 2560 / Math.max(w, TEMP_TILE_HEIGHT));
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(TEMP_TILE_HEIGHT * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    draw(strokes);
    const onRestored = () => draw(latestStrokes.current);
    canvas.addEventListener('contextrestored', onRestored);
    return () => canvas.removeEventListener('contextrestored', onRestored);
  }, [width, strokes, draw]);

  return (
    <canvas
      ref={canvasRef}
      className="temp-ink-tile"
      style={{
        top: tileIndex * TEMP_TILE_HEIGHT,
        width,
        height: TEMP_TILE_HEIGHT,
      }}
    />
  );
});

export interface TempInkOverlayProps {
  active: boolean;
  totalHeight: number;
  blockOffsets?: readonly BlockLayoutOffset[];
  strokes: InkStroke[];
  session: InkToolSession;
  allowMouse?: boolean;
  onChange: (nextStrokes: InkStroke[]) => void;
  onClose: () => void;
}

export function TempInkOverlay({
  active,
  totalHeight,
  blockOffsets,
  strokes,
  session,
  allowMouse = false,
  onChange,
  onClose,
}: TempInkOverlayProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const tileDrawersRef = useRef(new Map<number, (list: readonly InkStroke[]) => void>());

  const [width, setWidth] = useState(360);
  const [undoStack, setUndoStack] = useState<InkStroke[][]>([]);
  const [redoStack, setRedoStack] = useState<InkStroke[][]>([]);

  const activeStroke = useRef<InkStroke | null>(null);
  const workingStrokes = useRef<InkStroke[] | null>(null);
  const eraseDirty = useRef(false);
  const lastErasePt = useRef<{ x: number; y: number } | null>(null);
  const hoverCursor = useRef<{ x: number; y: number } | null>(null);
  const activePointer = useRef<number | null>(null);
  const activeMode = useRef<'draw' | 'erase'>('draw');
  const isLongPressErase = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ x: number; y: number; pt: InkPoint } | null>(null);
  const strokeStartMs = useRef<number>(0);
  const lastDownWasPen = useRef(false);
  const lastPenEventWall = useRef(0);
  const suppressClicksUntil = useRef(0);
  const liveSliceTopRef = useRef(0);
  const liveSliceHeightRef = useRef(TEMP_LIVE_SLICE_HEIGHT);
  const liveVisibleRef = useRef(false);

  const latestBlockOffsets = useRef(blockOffsets);
  latestBlockOffsets.current = blockOffsets;

  const anchorSignature = (() => {
    if (!blockOffsets || blockOffsets.length === 0 || strokes.length === 0) return '';
    const seen = new Set<number>();
    const parts: string[] = [];
    for (let i = 0; i < strokes.length; i++) {
      const idx = strokes[i].anchorBlockIndex;
      if (typeof idx !== 'number' || seen.has(idx)) continue;
      seen.add(idx);
      const b =
        idx >= 0 && idx < blockOffsets.length && blockOffsets[idx].index === idx
          ? blockOffsets[idx]
          : blockOffsets.find((item) => item.index === idx);
      if (b) parts.push(`${idx}:${Math.round(b.start * 2) / 2}`);
    }
    return parts.join(',');
  })();

  const resolvedStrokes = useMemo(
    () => resolveAnchoredStrokes(strokes, blockOffsets ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strokes, anchorSignature],
  );

  const latestStrokes = useRef(resolvedStrokes);
  latestStrokes.current = resolvedStrokes;
  const latestWidth = useRef(width);
  latestWidth.current = width;
  const latestSession = useRef(session);
  latestSession.current = session;

  const registerTileDrawer = useCallback(
    (tileIndex: number, fn: ((list: readonly InkStroke[]) => void) | null) => {
      if (fn) tileDrawersRef.current.set(tileIndex, fn);
      else tileDrawersRef.current.delete(tileIndex);
    },
    [],
  );

  // Measure host width reliably (no sticky viewport tracking needed!)
  useEffect(() => {
    const host = wrapperRef.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const w = host.clientWidth;
      if (w > 0 && w !== latestWidth.current) {
        latestWidth.current = w;
        setWidth(w);
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (active && session.tool === 'browse') {
      session.selectTool(session.activeBrush);
    }
  }, [active]);

  const overlayHeight = Math.max(Math.ceil(totalHeight), 400);
  const liveHeight = Math.min(overlayHeight, TEMP_LIVE_SLICE_HEIGHT);
  liveSliceHeightRef.current = liveHeight;

  const paintLive = useCallback(
    (
      stroke: InkStroke | null,
      predictedPts: InkPoint[] = [],
      cursor: { x: number; y: number; r: number; longPress: boolean } | null = null,
    ) => {
      const canvas = liveCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (!stroke && !cursor) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.visibility = 'hidden';
        liveVisibleRef.current = false;
        return;
      }

      const w = Math.max(1, latestWidth.current);
      const lH = Math.max(200, liveSliceHeightRef.current);

      // Keep the document-space live canvas slice centered on the pen tip without ever clipping near the bottom
      const focusY = cursor
        ? cursor.y
        : stroke && stroke.points.length > 0
          ? stroke.points[stroke.points.length - 1].y
          : 0;
      let sliceTop = liveSliceTopRef.current;
      if (!liveVisibleRef.current || focusY < sliceTop + 90 || focusY > sliceTop + lH - 90) {
        sliceTop = Math.max(0, Math.floor(focusY - lH * 0.45));
        liveSliceTopRef.current = sliceTop;
        canvas.style.top = `${sliceTop}px`;
      }
      canvas.style.visibility = 'visible';
      liveVisibleRef.current = true;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / w, 0, 0, canvas.height / lH, 0, 0);
      ctx.translate(0, -sliceTop);

      if (stroke && stroke.points.length > 0) {
        const displayStroke =
          predictedPts.length > 0 ? { ...stroke, points: [...stroke.points, ...predictedPts] } : stroke;
        drawStrokeToCanvas(ctx, displayStroke, w, 1, false);
      }
      if (cursor) {
        drawEraserCursor(ctx, cursor.x * w, cursor.y, cursor.r, cursor.longPress);
      }
    },
    [],
  );

  // Ensure live canvas backing resolution stays crisp whenever width or overlay height changes,
  // and immediately re-paint any in-progress stroke if resized mid-stroke.
  useEffect(() => {
    const canvas = liveCanvasRef.current;
    if (!canvas) return;
    const w = Math.max(200, width);
    const h = Math.max(200, liveHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75, 2560 / Math.max(w, h));
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      if (activeStroke.current) {
        paintLive(activeStroke.current);
      }
    }
  }, [width, liveHeight, paintLive]);

  // Compute only the non-empty document tiles intersecting strokes
  const activeTileIndices = useMemo(() => {
    const set = new Set<number>();
    const w = Math.max(1, width);
    for (let i = 0; i < resolvedStrokes.length; i++) {
      const bb = getStrokeBoundingBox(resolvedStrokes[i], w, 1);
      if (!bb) continue;
      const startTile = Math.max(0, Math.floor((bb.minY - 24) / TEMP_TILE_HEIGHT));
      const endTile = Math.max(startTile, Math.floor((bb.maxY + 24) / TEMP_TILE_HEIGHT));
      for (let t = startTile; t <= endTile; t++) set.add(t);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [resolvedStrokes, width]);

  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  const commit = useCallback((next: InkStroke[], recordHistory = true) => {
    if (recordHistory) {
      setUndoStack((prev) => [...prev.slice(-29), latestStrokes.current]);
      setRedoStack([]);
    }
    latestOnChange.current(next);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  }, []);

  const redrawTilesInRange = useCallback((minY: number, maxY: number, list: readonly InkStroke[]) => {
    const startTile = Math.max(0, Math.floor((minY - 36) / TEMP_TILE_HEIGHT));
    const endTile = Math.max(startTile, Math.floor((maxY + 36) / TEMP_TILE_HEIGHT));
    for (let t = startTile; t <= endTile; t++) {
      tileDrawersRef.current.get(t)?.(list);
    }
  }, []);

  const redrawAllMountedTiles = useCallback((list: readonly InkStroke[]) => {
    for (const drawFn of tileDrawersRef.current.values()) {
      drawFn(list);
    }
  }, []);

  const applyEraseSegment = useCallback(
    (ax: number, ay: number, bx: number, by: number) => {
      const cur = workingStrokes.current ?? latestStrokes.current;
      const w = latestWidth.current;
      const r = latestSession.current.eraserRadius;

      if (latestSession.current.eraserMode === 'stroke') {
        let minY = Math.min(ay, by) - r - 24;
        let maxY = Math.max(ay, by) + r + 24;
        const next = cur.filter((s) => {
          const hit = hitTestStroke(s, bx, by, r, w, 1) || hitTestStroke(s, ax, ay, r, w, 1);
          if (hit) {
            const bb = getStrokeBoundingBox(s, w, 1);
            if (bb) {
              minY = Math.min(minY, bb.minY);
              maxY = Math.max(maxY, bb.maxY);
            }
          }
          return !hit;
        });
        if (next.length !== cur.length) {
          workingStrokes.current = next;
          eraseDirty.current = true;
          redrawTilesInRange(minY, maxY, next);
        }
        return;
      }

      const { strokes: next, changed } = eraseStrokesAtSegment(
        cur,
        ax,
        ay,
        bx,
        by,
        r,
        w,
        1,
        () => nextId('tmp'),
      );
      if (changed) {
        workingStrokes.current = next;
        eraseDirty.current = true;
        redrawTilesInRange(Math.min(ay, by) - r - 30, Math.max(ay, by) + r + 30, next);
      }
    },
    [redrawTilesInRange],
  );

  const toOverlayPoint = (
    clientX: number,
    clientY: number,
    pressure: number,
    timeStamp: number,
  ): InkPoint | null => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = Math.max(0, clientY - rect.top);
    return {
      x: roundNormalized(x),
      y: roundLogical(y),
      p: Math.round(pressure * 100) / 100,
      t: Math.max(0, Math.round(timeStamp - strokeStartMs.current)),
    };
  };

  const interactive = active && session.tool !== 'browse';

  // Attach stylus-only capture handlers on the scrollable note container when interactive.
  // Finger touches ('touch' / touchType === 'direct') NEVER get captured, CSS-locked, or prevented,
  // so 120Hz scrolling + clicking <details> foldouts, links, and buttons stay 100% native!
  useEffect(() => {
    const scroller = findScrollContainer(wrapperRef.current);

    const detachActiveWindowListeners = () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerCancel);
    };

    const finishPenStroke = (pointerId: number, canceled: boolean) => {
      cancelLongPress();
      if (activePointer.current !== pointerId) return;
      activePointer.current = null;
      lastDownWasPen.current = false;
      detachActiveWindowListeners();

      if (activeMode.current === 'erase') {
        const modified = eraseDirty.current && workingStrokes.current !== null;
        const committed = workingStrokes.current;
        workingStrokes.current = null;
        eraseDirty.current = false;
        lastErasePt.current = null;
        isLongPressErase.current = false;
        paintLive(null);
        if (!canceled && modified && committed) {
          commit(committed, true);
        } else {
          redrawAllMountedTiles(latestStrokes.current);
        }
        return;
      }

      const done = activeStroke.current;
      activeStroke.current = null;
      paintLive(null);
      if (!canceled && done && done.points.length > 0) {
        commit([...latestStrokes.current, done], true);
      }
    };

    const resetTransientStroke = () => {
      detachActiveWindowListeners();
      cancelLongPress();
      activePointer.current = null;
      activeStroke.current = null;
      workingStrokes.current = null;
      eraseDirty.current = false;
      lastErasePt.current = null;
      isLongPressErase.current = false;
      hoverCursor.current = null;
      lastDownWasPen.current = false;
      paintLive(null);
      redrawAllMountedTiles(latestStrokes.current);
    };

    const forceResetAll = () => {
      resetTransientStroke();
      scroller?.classList.remove('temp-ink-active');
    };

    const isForeignTarget = (target: EventTarget | null): boolean => {
      const el = target instanceof Element ? target : null;
      return !!el?.closest(
        '.handwriting-pad, .pad-fullscreen-modal, .floating-ink-toolbox, .floating-ink-bubble, .pad-insert-slot, .pad-insert-banner, .pad-corner-controls, .ink-toast, .pad-jump-bar, input, select, textarea',
      );
    };

    const onWindowPointerMove = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      lastPenEventWall.current = Date.now();
      e.preventDefault();

      const extEvt = e as PointerEvent & { getPredictedEvents?: () => PointerEvent[] };
      const samples = typeof extEvt.getCoalescedEvents === 'function' ? extEvt.getCoalescedEvents() : [];
      const events = samples.length > 0 ? samples : [extEvt];
      const w = latestWidth.current;

      if (activeMode.current === 'erase') {
        let latestPt: InkPoint | null = null;
        for (const ev of events) {
          const pt = toOverlayPoint(ev.clientX, ev.clientY, ev.pressure || 0.5, ev.timeStamp || Date.now());
          if (!pt) continue;
          const prev = lastErasePt.current ?? { x: pt.x, y: pt.y };
          applyEraseSegment(prev.x, prev.y, pt.x, pt.y);
          lastErasePt.current = { x: pt.x, y: pt.y };
          latestPt = pt;
        }
        if (latestPt) {
          paintLive(null, [], {
            x: latestPt.x,
            y: latestPt.y,
            r: latestSession.current.eraserRadius,
            longPress: isLongPressErase.current,
          });
        }
        return;
      }

      if (longPressStart.current) {
        if (Math.hypot(e.clientX - longPressStart.current.x, e.clientY - longPressStart.current.y) > 7) {
          cancelLongPress();
        }
      }

      const cur = activeStroke.current;
      if (!cur) return;
      for (const ev of events) {
        const pt = toOverlayPoint(ev.clientX, ev.clientY, ev.pressure || 0.5, ev.timeStamp || Date.now());
        if (!pt) continue;
        if (cur.tool === 'line') {
          cur.points = [cur.points[0], snapLinePoint(cur.points[0], pt, w, 1)];
        } else {
          cur.points = appendPointFiltered(cur.points, pt, 0.6, w, 1, 2000);
        }
        if (longPressStart.current) longPressStart.current.pt = pt;
      }

      const predictedPts: InkPoint[] = [];
      if (cur.tool !== 'line' && typeof extEvt.getPredictedEvents === 'function') {
        const predicted = extEvt.getPredictedEvents();
        for (let i = 0; i < Math.min(2, predicted.length); i++) {
          const pev = predicted[i];
          const ppt = toOverlayPoint(
            pev.clientX,
            pev.clientY,
            cur.points[cur.points.length - 1]?.p ?? 0.5,
            pev.timeStamp || Date.now(),
          );
          if (ppt) predictedPts.push(ppt);
        }
      }
      paintLive(cur, predictedPts);
    };

    const onWindowPointerUp = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      finishPenStroke(e.pointerId, false);
    };

    const onWindowPointerCancel = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      const hasDrawnWork =
        activeMode.current === 'erase'
          ? eraseDirty.current
          : (activeStroke.current?.points.length ?? 0) >= 2;
      finishPenStroke(e.pointerId, !hasDrawnWork);
    };

    if (!interactive || !scroller) {
      forceResetAll();
      return;
    }

    scroller.classList.add('temp-ink-active');

    const onScrollerPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === 'pen' && hoverCursor.current) {
        hoverCursor.current = null;
        if (activePointer.current === null) paintLive(null);
      }
    };

    const onPointerDownCapture = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        const penActivelyDrawing =
          activePointer.current !== null && Date.now() - lastPenEventWall.current < 250;
        if (!penActivelyDrawing) {
          lastDownWasPen.current = false;
          suppressClicksUntil.current = 0;
          if (activePointer.current !== null) {
            finishPenStroke(activePointer.current, false);
          }
        }
        return;
      }

      const isPen = e.pointerType === 'pen';
      const isAllowedMouse = allowMouse && e.pointerType === 'mouse' && e.button === 0;
      if (!isPen && !isAllowedMouse) return;
      if (isForeignTarget(e.target)) return;

      if (activePointer.current !== null) {
        finishPenStroke(activePointer.current, false);
      }

      strokeStartMs.current = e.timeStamp || Date.now();
      const pt = toOverlayPoint(e.clientX, e.clientY, e.pressure || 0.5, strokeStartMs.current);
      if (!pt) return;

      e.preventDefault();
      e.stopPropagation();
      lastDownWasPen.current = isPen;
      lastPenEventWall.current = Date.now();
      suppressClicksUntil.current = Date.now() + 450;
      activePointer.current = e.pointerId;

      window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerCancel);

      const s = latestSession.current;
      if (s.tool === 'eraser' || isStylusEraser(e)) {
        activeMode.current = 'erase';
        isLongPressErase.current = false;
        workingStrokes.current = [...latestStrokes.current];
        eraseDirty.current = false;
        lastErasePt.current = { x: pt.x, y: pt.y };
        applyEraseSegment(pt.x, pt.y, pt.x, pt.y);
        paintLive(null, [], { x: pt.x, y: pt.y, r: s.eraserRadius, longPress: false });
        return;
      }

      activeMode.current = 'draw';
      isLongPressErase.current = false;
      const brush = s.activeBrush;
      const prof = s.profiles[brush];
      const anchor = findAnchorBlockForY(pt.y, latestBlockOffsets.current ?? []);
      const created: InkStroke = {
        id: nextId('tmp'),
        tool: brush,
        color: prof.color,
        width: prof.width,
        opacity: prof.opacity,
        pressureSensitivity: prof.pressureSensitivity,
        ...(anchor ?? {}),
        points: [pt],
      };
      activeStroke.current = created;
      paintLive(created);

      if (isPen && brush !== 'line') {
        cancelLongPress();
        longPressStart.current = { x: e.clientX, y: e.clientY, pt };
        const pid = e.pointerId;
        longPressTimer.current = window.setTimeout(() => {
          longPressTimer.current = null;
          if (activePointer.current !== pid || !longPressStart.current) return;
          const holdPt = longPressStart.current.pt;
          longPressStart.current = null;
          activeStroke.current = null;
          activeMode.current = 'erase';
          isLongPressErase.current = true;
          workingStrokes.current = [...latestStrokes.current];
          eraseDirty.current = false;
          lastErasePt.current = { x: holdPt.x, y: holdPt.y };
          triggerLightHaptic();
          applyEraseSegment(holdPt.x, holdPt.y, holdPt.x, holdPt.y);
          paintLive(null, [], {
            x: holdPt.x,
            y: holdPt.y,
            r: latestSession.current.eraserRadius,
            longPress: true,
          });
        }, 380);
      }
    };

    const onScrollerPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'pen' || activePointer.current !== null) return;
      if (!isForeignTarget(e.target) && (latestSession.current.tool === 'eraser' || isStylusEraser(e))) {
        const pt = toOverlayPoint(e.clientX, e.clientY, 0.5, e.timeStamp || Date.now());
        if (pt) {
          hoverCursor.current = { x: pt.x, y: pt.y };
          paintLive(null, [], {
            x: pt.x,
            y: pt.y,
            r: latestSession.current.eraserRadius,
            longPress: false,
          });
        }
      } else if (hoverCursor.current) {
        hoverCursor.current = null;
        paintLive(null);
      }
    };

    // In Chromium Android WebView, pointerdown (pointerType === 'pen' vs 'touch') fires
    // synchronously BEFORE touchstart, while Touch.touchType is undefined. Suppress scroll ONLY
    // when an S-Pen contact was just recognized, keeping finger scrolling and clicks 100% native.
    const isOverlayPenTouchActive = (e: TouchEvent): boolean =>
      touchEventHasStylus(e) ||
      lastDownWasPen.current ||
      (activePointer.current !== null && Date.now() - lastPenEventWall.current < 1500);

    const onTouchStartCapture = (e: TouchEvent) => {
      if (isOverlayPenTouchActive(e)) {
        e.preventDefault();
      }
    };

    const onTouchMoveCapture = (e: TouchEvent) => {
      if (isOverlayPenTouchActive(e)) {
        e.preventDefault();
      }
    };

    const onWindowTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        if (Date.now() - lastPenEventWall.current > 120) {
          lastDownWasPen.current = false;
          if (activePointer.current !== null) {
            finishPenStroke(activePointer.current, false);
          }
        }
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      if (Date.now() < suppressClicksUntil.current && !isForeignTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (lastDownWasPen.current || activePointer.current !== null || Date.now() < suppressClicksUntil.current) {
        e.preventDefault();
      }
    };

    const onLostFocus = () => resetTransientStroke();

    scroller.addEventListener('pointerleave', onScrollerPointerLeave);
    scroller.addEventListener('pointermove', onScrollerPointerMove);
    scroller.addEventListener('pointerdown', onPointerDownCapture, { capture: true });
    scroller.addEventListener('touchstart', onTouchStartCapture, { capture: true, passive: false });
    scroller.addEventListener('touchmove', onTouchMoveCapture, { capture: true, passive: false });
    scroller.addEventListener('click', onClickCapture, { capture: true });
    scroller.addEventListener('contextmenu', onContextMenu, { capture: true });
    window.addEventListener('touchend', onWindowTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onWindowTouchEnd, { passive: true });
    window.addEventListener('blur', onLostFocus);
    document.addEventListener('visibilitychange', onLostFocus);

    return () => {
      forceResetAll();
      scroller.removeEventListener('pointerleave', onScrollerPointerLeave);
      scroller.removeEventListener('pointermove', onScrollerPointerMove);
      scroller.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
      scroller.removeEventListener('touchstart', onTouchStartCapture, { capture: true });
      scroller.removeEventListener('touchmove', onTouchMoveCapture, { capture: true });
      scroller.removeEventListener('click', onClickCapture, { capture: true });
      scroller.removeEventListener('contextmenu', onContextMenu, { capture: true });
      window.removeEventListener('touchend', onWindowTouchEnd);
      window.removeEventListener('touchcancel', onWindowTouchEnd);
      window.removeEventListener('blur', onLostFocus);
      document.removeEventListener('visibilitychange', onLostFocus);
    };
  }, [interactive, allowMouse, cancelLongPress, commit, applyEraseSegment, paintLive, redrawAllMountedTiles]);

  return (
    <>
      <div
        ref={wrapperRef}
        className={`temp-ink-overlay ${interactive ? 'interactive' : ''}`}
        style={{
          width,
          height: overlayHeight,
          pointerEvents: 'none',
        }}
      >
        {activeTileIndices.map((tileIndex) => (
          <TempInkTileCanvas
            key={tileIndex}
            tileIndex={tileIndex}
            width={width}
            strokes={resolvedStrokes}
            registerDrawer={registerTileDrawer}
          />
        ))}
        <canvas
          ref={liveCanvasRef}
          className="temp-ink-live"
          style={{
            width,
            height: liveHeight,
            pointerEvents: 'none',
          }}
        />
      </div>

      <FloatingInkToolbox
        open={active}
        title="临时涂鸦"
        notice="手写笔书写/涂改，手指可滑动或点击折叠栏；修改 MD 将清除临时墨迹"
        session={session}
        allowMouse={allowMouse}
        showBrowse={true}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        hasStrokes={strokes.length > 0}
        onUndo={() => {
          if (undoStack.length === 0) return;
          const prev = undoStack[undoStack.length - 1];
          setUndoStack((s) => s.slice(0, -1));
          setRedoStack((s) => [...s.slice(-29), strokes]);
          onChange(prev);
        }}
        onRedo={() => {
          if (redoStack.length === 0) return;
          const next = redoStack[redoStack.length - 1];
          setRedoStack((s) => s.slice(0, -1));
          setUndoStack((s) => [...s.slice(-29), strokes]);
          onChange(next);
        }}
        onClear={() => commit([], true)}
        onDone={onClose}
      />
    </>
  );
}

/* ===========================
 * Arbitrary-Line Insertion Banner & Slot
 * =========================== */

export interface PadInsertBannerProps {
  mode: 'create' | 'move';
  title: string;
  background: PadBackground;
  onTitleChange: (title: string) => void;
  onBackgroundChange: (bg: PadBackground) => void;
  onPickTop: () => void;
  onPickBottom: () => void;
  onCancel: () => void;
}

export function PadInsertBanner({
  mode,
  title,
  background,
  onTitleChange,
  onBackgroundChange,
  onPickTop,
  onPickBottom,
  onCancel,
}: PadInsertBannerProps) {
  return (
    <div className="pad-insert-banner" role="region" aria-label={mode === 'create' ? '选择手写栏插入位置' : '选择手写栏新位置'}>
      <div className="pad-insert-banner-top">
        <div className="pad-insert-banner-title">
          <strong>{mode === 'create' ? '选择手写栏插入位置' : '移动手写栏位置'}</strong>
          <span>滑动笔记，点击任意一行下方的「+ 在此处插入」即可</span>
        </div>
        <div className="pad-insert-banner-quick">
          <button type="button" className="ink-btn" onClick={onPickTop}>
            放到顶部
          </button>
          <button type="button" className="ink-btn" onClick={onPickBottom}>
            放到底部
          </button>
          <button type="button" className="ink-btn danger" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
      {mode === 'create' && (
        <div className="pad-insert-banner-opts">
          <input
            className="pad-insert-title-input"
            value={title}
            maxLength={60}
            placeholder="手写栏标题（可选）"
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <div className="pad-insert-bg-pills">
            {PAD_BACKGROUNDS.map((bg) => (
              <button
                key={bg.id}
                type="button"
                className={background === bg.id ? 'ink-btn active' : 'ink-btn'}
                onClick={() => onBackgroundChange(bg.id)}
              >
                {bg.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function InsertPadSlot({
  mode,
  label,
  onSelect,
}: {
  mode: 'create' | 'move';
  label?: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="pad-insert-slot" onClick={onSelect}>
      <span className="pad-insert-slot-line" />
      <span className="pad-insert-slot-pill">
        {mode === 'create' ? '+ 在此处插入手写栏' : '移至此处'}
        {label ? ` · ${label}` : ''}
      </span>
      <span className="pad-insert-slot-line" />
    </button>
  );
}

/**
 * Deterministic finger scroll controller for regions where CSS `touch-action: none`
 * locks Chromium compositor scrolling so S-Pen can never accidentally scroll the page
 * (`.note-preview-scroll.temp-ink-active`, `.pad-canvas-box`, and `.pad-fullscreen-scroll`).
 *
 * - Accepts ALL finger sizes (no contact-width rejection) so tablet fingers always scroll.
 * - Uses a 6px tap slop without preventing `pointerdown`/`touchstart`, keeping `<details>`,
 *   `<summary>`, buttons, and links 100% clickable via finger tap.
 * - Rejects palm touches while S-Pen is down or within 150ms of pen lift, and aborts
 *   momentum immediately when S-Pen touches the glass.
 */
export function useFingerScrollController(
  rootRef: React.RefObject<HTMLElement | null>,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;

    const activePenIds = new Set<number>();
    let lastPenEventMs = 0;
    let lastPenLiftMs = 0;
    let suppressClickUntil = 0;
    let momentumRaf: number | null = null;

    interface DragState {
      pointerId: number;
      scrollEl: HTMLElement;
      allowX: boolean;
      allowY: boolean;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      dragging: boolean;
      samples: Array<{ t: number; x: number; y: number }>;
    }

    let drag: DragState | null = null;

    const stopMomentum = () => {
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }
    };

    const detachDragWindowListeners = () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerEnd);
      window.removeEventListener('pointercancel', onWindowPointerEnd);
    };

    const clearDrag = () => {
      drag = null;
      detachDragWindowListeners();
    };

    const startMomentum = (scrollEl: HTMLElement, vx0: number, vy0: number, allowX: boolean, allowY: boolean) => {
      stopMomentum();
      let vx = allowX ? vx0 : 0;
      let vy = allowY ? vy0 : 0;
      let prevTime = performance.now();

      const step = (now: number) => {
        if (activePenIds.size > 0 || drag !== null) {
          momentumRaf = null;
          return;
        }
        const dt = Math.min(32, Math.max(1, now - prevTime));
        prevTime = now;
        const decay = Math.pow(0.945, dt / 16.67);
        vx *= decay;
        vy *= decay;

        let moved = false;
        if (allowY && Math.abs(vy) > 0.025) {
          const before = scrollEl.scrollTop;
          scrollEl.scrollTop = before - vy * dt;
          if (Math.abs(scrollEl.scrollTop - before) > 0.05) moved = true;
          else vy = 0;
        }
        if (allowX && Math.abs(vx) > 0.025) {
          const before = scrollEl.scrollLeft;
          scrollEl.scrollLeft = before - vx * dt;
          if (Math.abs(scrollEl.scrollLeft - before) > 0.05) moved = true;
          else vx = 0;
        }

        if (moved && (Math.abs(vy) > 0.025 || Math.abs(vx) > 0.025)) {
          momentumRaf = requestAnimationFrame(step);
        } else {
          momentumRaf = null;
        }
      };

      momentumRaf = requestAnimationFrame(step);
    };

    const resolveScrollTarget = (target: EventTarget | null): { el: HTMLElement; allowX: boolean; allowY: boolean } | null => {
      const el = target instanceof Element ? target : null;
      if (!el) return null;
      // Never hijack interactive floating toolboxes, inputs, or sliders
      if (
        el.closest(
          '.floating-ink-toolbox, .floating-ink-bubble, input, textarea, select, [data-no-finger-scroll]',
        )
      ) {
        return null;
      }
      // Fullscreen zoomed pad modal (rendered in a body portal)
      const fsScroll = el.closest('.pad-fullscreen-scroll') as HTMLElement | null;
      if (fsScroll && el.closest('.pad-canvas-box')) {
        return { el: fsScroll, allowX: true, allowY: true };
      }
      const root = rootRef.current;
      if (!root || !root.contains(el)) return null;
      const previewScroll = el.closest('.note-preview-scroll') as HTMLElement | null;
      if (!previewScroll) return null;
      // Only take over when CSS `touch-action: none` actually disables native browser scroll
      const lockedByTempInk = previewScroll.classList.contains('temp-ink-active');
      const lockedByPadCanvas = !!el.closest('.pad-canvas-box');
      if (!lockedByTempInk && !lockedByPadCanvas) return null;
      return { el: previewScroll, allowX: false, allowY: true };
    };

    const onWindowPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        lastPenEventMs = Date.now();
        stopMomentum();
        clearDrag();
        return;
      }
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (activePenIds.size > 0 && Date.now() - lastPenEventMs < 2000) {
        clearDrag();
        return;
      }

      const now = performance.now();
      const totalDist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (!drag.dragging) {
        if (totalDist < 6) return;
        drag.dragging = true;
        suppressClickUntil = Date.now() + 280;
        const initDx = e.clientX - drag.startX;
        const initDy = e.clientY - drag.startY;
        if (drag.allowY) drag.scrollEl.scrollTop -= initDy;
        if (drag.allowX) drag.scrollEl.scrollLeft -= initDx;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        drag.samples = [{ t: now, x: e.clientX, y: e.clientY }];
        return;
      }

      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      if (drag.allowY) drag.scrollEl.scrollTop -= dy;
      if (drag.allowX) drag.scrollEl.scrollLeft -= dx;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.samples.push({ t: now, x: e.clientX, y: e.clientY });
      const cutoff = now - 95;
      while (drag.samples.length > 2 && drag.samples[0].t < cutoff) {
        drag.samples.shift();
      }
    };

    const onWindowPointerEnd = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        activePenIds.delete(e.pointerId);
        lastPenLiftMs = Date.now();
        return;
      }
      if (!drag || e.pointerId !== drag.pointerId) return;
      const finished = drag;
      clearDrag();

      if (finished.dragging && e.type === 'pointerup') {
        suppressClickUntil = Date.now() + 240;
        const now = performance.now();
        const samples = finished.samples;
        if (samples.length >= 2 && now - samples[samples.length - 1].t < 100) {
          const first = samples[0];
          const last = samples[samples.length - 1];
          const dt = Math.max(8, last.t - first.t);
          const clampV = (v: number) => Math.max(-4.5, Math.min(4.5, v));
          const vx = clampV((last.x - first.x) / dt);
          const vy = clampV((last.y - first.y) / dt);
          if ((finished.allowY && Math.abs(vy) > 0.08) || (finished.allowX && Math.abs(vx) > 0.08)) {
            startMomentum(finished.scrollEl, vx, vy, finished.allowX, finished.allowY);
          }
        }
      }
    };

    const onDocumentPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        activePenIds.add(e.pointerId);
        lastPenEventMs = Date.now();
        stopMomentum();
        clearDrag();
        return;
      }
      if (e.pointerType !== 'touch') return;

      // Clear stale pen IDs if a pen pointerup was ever dropped by the OS
      if (activePenIds.size > 0 && Date.now() - lastPenEventMs > 2000) {
        activePenIds.clear();
      }
      // Palm rejection while S-Pen is actively touching or just lifted
      if (activePenIds.size > 0 || Date.now() - lastPenLiftMs < 150) return;

      const target = resolveScrollTarget(e.target);
      if (!target) return;

      stopMomentum();
      clearDrag();
      const now = performance.now();
      drag = {
        pointerId: e.pointerId,
        scrollEl: target.el,
        allowX: target.allowX,
        allowY: target.allowY,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        dragging: false,
        samples: [{ t: now, x: e.clientX, y: e.clientY }],
      };
      window.addEventListener('pointermove', onWindowPointerMove, { passive: true });
      window.addEventListener('pointerup', onWindowPointerEnd, { passive: true });
      window.addEventListener('pointercancel', onWindowPointerEnd, { passive: true });
    };

    const onDocumentPenEnd = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        activePenIds.delete(e.pointerId);
        lastPenLiftMs = Date.now();
      }
    };

    const onDocumentClickCapture = (e: MouseEvent) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onReset = () => {
      stopMomentum();
      clearDrag();
      activePenIds.clear();
    };

    document.addEventListener('pointerdown', onDocumentPointerDown, { capture: true, passive: true });
    window.addEventListener('pointerup', onDocumentPenEnd, { capture: true, passive: true });
    window.addEventListener('pointercancel', onDocumentPenEnd, { capture: true, passive: true });
    document.addEventListener('click', onDocumentClickCapture, { capture: true });
    window.addEventListener('blur', onReset);
    document.addEventListener('visibilitychange', onReset);

    return () => {
      onReset();
      document.removeEventListener('pointerdown', onDocumentPointerDown, { capture: true });
      window.removeEventListener('pointerup', onDocumentPenEnd, { capture: true });
      window.removeEventListener('pointercancel', onDocumentPenEnd, { capture: true });
      document.removeEventListener('click', onDocumentClickCapture, { capture: true });
      window.removeEventListener('blur', onReset);
      document.removeEventListener('visibilitychange', onReset);
    };
  }, [rootRef, enabled]);
}
