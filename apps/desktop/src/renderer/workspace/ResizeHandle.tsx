import { useEffect, useRef, type PointerEvent } from 'react';
export function ResizeHandle({
  label,
  axis = 'x',
  value,
  min,
  max,
  onChange,
  onResizing,
  reverse = false,
  cssVariable,
  measure,
}: {
  label: string;
  axis?: 'x' | 'y';
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onResizing: (value: boolean) => void;
  reverse?: boolean;
  cssVariable?: string;
  measure?: string;
}) {
  const drag = useRef<{
      position: number;
      value: number;
      next: number;
      target: HTMLElement | null;
      original: string;
    } | null>(null),
    raf = useRef(0);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const paint = () => {
    raf.current = 0;
    const d = drag.current;
    if (d && cssVariable && d.target) d.target.style.setProperty(cssVariable, d.next + 'px');
  };
  const finish = (cancel = false) => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    drag.current = null;
    if (d.target && cssVariable) d.target.style.setProperty(cssVariable, d.original);
    if (!cancel) onChange(d.next);
    onResizing(false);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(true);
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      cancelAnimationFrame(raf.current);
      const d = drag.current;
      if (d?.target && cssVariable) d.target.style.setProperty(cssVariable, d.original);
    };
  }, [cssVariable]);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = document.querySelector<HTMLElement>('.app'),
      rect = measure ? document.querySelector(measure)?.getBoundingClientRect() : undefined,
      actual = rect ? (axis === 'x' ? rect.width : rect.height) : value;
    drag.current = {
      position: axis === 'x' ? event.clientX : event.clientY,
      value: clamp(actual),
      next: clamp(actual),
      target,
      original: cssVariable ? target?.style.getPropertyValue(cssVariable) || '' : '',
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizing(true);
  };
  return (
    <div
      className={'resize-handle ' + axis}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={start}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        d.next = clamp(
          d.value + (reverse ? -1 : 1) * ((axis === 'x' ? event.clientX : event.clientY) - d.position),
        );
        if (cssVariable) {
          if (!raf.current) raf.current = requestAnimationFrame(paint);
        } else if (!raf.current)
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            if (drag.current) onChange(drag.current.next);
          });
      }}
      onPointerUp={() => finish()}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish()}
      onDoubleClick={() => onChange(clamp(axis === 'x' ? 300 : 450))}
      onKeyDown={(event) => {
        if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          onChange(
            clamp(value + (reverse ? -1 : 1) * (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -20 : 20)),
          );
        }
      }}
    />
  );
}
