import { useRef, type PointerEvent } from 'react';
export function ResizeHandle({
  label,
  axis = 'x',
  value,
  min,
  max,
  onChange,
  onResizing,
  reverse = false,
}: {
  label: string;
  axis?: 'x' | 'y';
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onResizing: (value: boolean) => void;
  reverse?: boolean;
}) {
  const drag = useRef<{ position: number; value: number } | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.button !== 0) return;
    drag.current = { position: axis === 'x' ? event.clientX : event.clientY, value };
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizing(true);
  };
  const end = () => {
    if (drag.current) {
      drag.current = null;
      onResizing(false);
    }
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
        const start = drag.current;
        if (start)
          onChange(
            clamp(
              start.value +
                (reverse ? -1 : 1) * ((axis === 'x' ? event.clientX : event.clientY) - start.position),
            ),
          );
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
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
