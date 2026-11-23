import {
  resolveBrushSpec,
  type HandwritingPad,
  type InkBlockRef,
  type InkHeadingRef,
  type InkPoint,
  type InkStroke,
  type PenBrushSpec,
} from './ink-types';

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export function strokeToSvgPath(points: InkPoint[], scaleX: number, scaleY: number): string {
  if (points.length === 0) return '';
  const x0 = points[0].x * scaleX;
  const y0 = points[0].y * scaleY;
  if (points.length === 1) {
    return `M ${fmt(x0)} ${fmt(y0)} L ${fmt(x0 + 0.05)} ${fmt(y0 + 0.05)}`;
  }
  if (points.length === 2) {
    const x1 = points[1].x * scaleX;
    const y1 = points[1].y * scaleY;
    return `M ${fmt(x0)} ${fmt(y0)} L ${fmt(x1)} ${fmt(y1)}`;
  }
  const parts: string[] = [`M ${fmt(x0)} ${fmt(y0)}`];
  for (let i = 1; i < points.length - 1; i++) {
    const cx = points[i].x * scaleX;
    const cy = points[i].y * scaleY;
    const nx = points[i + 1].x * scaleX;
    const ny = points[i + 1].y * scaleY;
    const mx = (cx + nx) / 2;
    const my = (cy + ny) / 2;
    parts.push(`Q ${fmt(cx)} ${fmt(cy)} ${fmt(mx)} ${fmt(my)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${fmt(last.x * scaleX)} ${fmt(last.y * scaleY)}`);
  return parts.join(' ');
}

interface Vec2 {
  x: number;
  y: number;
}

interface SampledPoint {
  x: number;
  y: number;
  p: number;
  t: number;
  cumDist: number;
  radius: number;
  tx: number;
  ty: number;
}

export interface StrokeRenderData {
  mode: 'fill' | 'stroke';
  d: string;
  color: string;
  opacity: number;
  strokeWidth?: number;
  linecap?: 'round' | 'butt' | 'square';
  multiply?: boolean;
}

export function hasRealPressureData(points: InkPoint[]): boolean {
  for (let i = 0; i < points.length; i++) {
    const p = points[i].p;
    if (typeof p === 'number' && Number.isFinite(p) && p > 0.01 && p < 0.99 && Math.abs(p - 0.5) > 0.025) {
      return true;
    }
  }
  return false;
}

function buildDotCirclePath(x: number, y: number, r: number): string {
  const rad = Math.max(0.5, r);
  return `M ${fmt(x - rad)} ${fmt(y)} A ${fmt(rad)} ${fmt(rad)} 0 1 0 ${fmt(x + rad)} ${fmt(y)} A ${fmt(rad)} ${fmt(rad)} 0 1 0 ${fmt(x - rad)} ${fmt(y)} Z`;
}

export function computeVariableStrokeSamples(
  points: InkPoint[],
  spec: PenBrushSpec,
  baseWidth: number,
  scaleX: number,
  scaleY: number,
  pressureSensitivity = 1.0,
): { samples: SampledPoint[]; totalLen: number; avgPressure: number } {
  if (points.length === 0) return { samples: [], totalLen: 0, avgPressure: 0.5 };
  const sensitivity = clamp(pressureSensitivity, 0, 1.5);
  const realPressure = hasRealPressureData(points);

  // 1. Scale and distance-adaptive position smoothing while preserving endpoints
  const alphaPos = clamp(1 - spec.streamline, 0.35, 1);
  const smoothed: { x: number; y: number; p: number; t: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const sx = points[i].x * scaleX;
    const sy = points[i].y * scaleY;
    const p = typeof points[i].p === 'number' && Number.isFinite(points[i].p) ? points[i].p! : 0.5;
    const t = typeof points[i].t === 'number' && Number.isFinite(points[i].t) ? points[i].t! : i * 16;
    if (i === 0) {
      smoothed.push({ x: sx, y: sy, p, t });
    } else {
      const prev = smoothed[smoothed.length - 1];
      const stepDist = Math.hypot(sx - prev.x, sy - prev.y);
      // Small steps (tight bends/hooks in CJK handwriting) stay virtually un-lagged
      const adaptiveAlpha = stepDist < 5 ? Math.max(alphaPos, 0.94) : alphaPos;
      const nx = prev.x + (sx - prev.x) * adaptiveAlpha;
      const ny = prev.y + (sy - prev.y) * adaptiveAlpha;
      if (Math.hypot(nx - prev.x, ny - prev.y) >= 0.2 || i === points.length - 1) {
        smoothed.push({ x: nx, y: ny, p, t });
      }
    }
  }
  if (points.length > 1) {
    const lastRaw = points[points.length - 1];
    const lx = lastRaw.x * scaleX;
    const ly = lastRaw.y * scaleY;
    const lastSm = smoothed[smoothed.length - 1];
    if (Math.hypot(lx - lastSm.x, ly - lastSm.y) > 0.15) {
      smoothed.push({
        x: lx,
        y: ly,
        p: typeof lastRaw.p === 'number' && Number.isFinite(lastRaw.p) ? lastRaw.p : lastSm.p,
        t: typeof lastRaw.t === 'number' ? lastRaw.t : lastSm.t + 4,
      });
    }
  }

  // 2. Cumulative distances & smoothed pressure/velocity
  const n = smoothed.length;
  const cumDist = new Float64Array(n);
  const smoothP = new Float64Array(n);
  let totalLen = 0;
  let pressureSum = 0;

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      cumDist[0] = 0;
      smoothP[0] = realPressure ? clamp(smoothed[0].p, 0.05, 1.0) : 0.55;
    } else {
      const dx = smoothed[i].x - smoothed[i - 1].x;
      const dy = smoothed[i].y - smoothed[i - 1].y;
      const dist = Math.hypot(dx, dy);
      totalLen += dist;
      cumDist[i] = totalLen;

      let rawP: number;
      if (realPressure) {
        rawP = clamp(smoothed[i].p, 0.04, 1.0);
      } else {
        const dt = Math.max(4, smoothed[i].t - smoothed[i - 1].t);
        const velocity = dist / dt; // logical units per ms
        rawP = clamp(0.86 - Math.min(1, velocity / 1.9) * 0.54, 0.22, 0.92);
      }
      smoothP[i] = smoothP[i - 1] * 0.6 + rawP * 0.4;
    }
    pressureSum += smoothP[i];
  }

  // 3. Tangents & radii
  const minS = Math.max(0.15, 1 - (1 - spec.minScale) * sensitivity);
  const maxS = 1 + (spec.maxScale - 1) * sensitivity;
  const samples: SampledPoint[] = [];

  for (let i = 0; i < n; i++) {
    let dx = 0;
    let dy = 0;
    if (n > 1) {
      if (i === 0) {
        dx = smoothed[1].x - smoothed[0].x;
        dy = smoothed[1].y - smoothed[0].y;
      } else if (i === n - 1) {
        dx = smoothed[n - 1].x - smoothed[n - 2].x;
        dy = smoothed[n - 1].y - smoothed[n - 2].y;
      } else {
        dx = smoothed[i + 1].x - smoothed[i - 1].x;
        dy = smoothed[i + 1].y - smoothed[i - 1].y;
      }
    }
    const mag = Math.hypot(dx, dy) || 1;
    const tx = dx / mag;
    const ty = dy / mag;

    const curvedP = Math.pow(smoothP[i], 0.88);
    const pressureScale = minS + (maxS - minS) * curvedP;

    let taper = 1;
    if (totalLen > 1 && (spec.taperStart > 0 || spec.taperEnd > 0)) {
      const startWindow = Math.min(spec.taperStart, totalLen * 0.28);
      const endWindow = Math.min(spec.taperEnd, totalLen * 0.32);
      const startFactor = startWindow > 0 ? Math.min(1, cumDist[i] / startWindow) : 1;
      const endFactor = endWindow > 0 ? Math.min(1, (totalLen - cumDist[i]) / endWindow) : 1;
      taper = 0.28 + 0.72 * Math.min(startFactor, endFactor);
    }

    let chisel = 1;
    if (spec.chiselAngleRad !== undefined && n > 1) {
      const angle = Math.atan2(ty, tx);
      chisel = 0.66 + 0.34 * Math.abs(Math.sin(angle - spec.chiselAngleRad));
    }

    const radius = Math.max(0.45, baseWidth * 0.5 * pressureScale * taper * chisel);
    samples.push({
      x: smoothed[i].x,
      y: smoothed[i].y,
      p: smoothP[i],
      t: smoothed[i].t,
      cumDist: cumDist[i],
      radius,
      tx,
      ty,
    });
  }

  return { samples, totalLen, avgPressure: pressureSum / n };
}

function buildCapArc(center: Vec2, fromAngle: number, toAngle: number, radius: number, steps: number): Vec2[] {
  let delta = toAngle - fromAngle;
  while (delta < 0) delta += Math.PI * 2;
  if (delta > Math.PI * 1.5) delta -= Math.PI * 2;
  const out: Vec2[] = [];
  for (let i = 1; i < steps; i++) {
    const a = fromAngle + (delta * i) / steps;
    out.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  return out;
}

function polygonToSmoothSvgPath(pts: Vec2[]): string {
  if (pts.length < 3) return '';
  const n = pts.length;
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(pts[n - 1], pts[0]);
  const parts: string[] = [`M ${fmt(start.x)} ${fmt(start.y)}`];
  for (let i = 0; i < n; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const m = mid(curr, next);
    parts.push(`Q ${fmt(curr.x)} ${fmt(curr.y)} ${fmt(m.x)} ${fmt(m.y)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

export function buildStrokeRenderData(
  stroke: InkStroke,
  scaleX: number,
  scaleY: number,
): StrokeRenderData {
  const spec = resolveBrushSpec(stroke.tool);
  const baseOpacity = clamp(stroke.opacity ?? spec.defaultOpacity, 0.1, 1);

  if (stroke.points.length === 0) {
    return { mode: 'stroke', d: '', color: stroke.color, opacity: baseOpacity, strokeWidth: stroke.width };
  }

  if (spec.id === 'line' || spec.id === 'highlight') {
    return {
      mode: 'stroke',
      d: strokeToSvgPath(stroke.points, scaleX, scaleY),
      color: stroke.color,
      opacity: baseOpacity,
      strokeWidth: stroke.width,
      linecap: spec.id === 'highlight' ? 'butt' : 'round',
      multiply: spec.multiply,
    };
  }

  const { samples, totalLen, avgPressure } = computeVariableStrokeSamples(
    stroke.points,
    spec,
    stroke.width,
    scaleX,
    scaleY,
    stroke.pressureSensitivity ?? 1.0,
  );

  const effectiveOpacity = spec.pressureOpacity
    ? clamp(baseOpacity * (0.62 + 0.68 * avgPressure), 0.25, 0.96)
    : baseOpacity;

  if (samples.length === 1 || totalLen < 0.8) {
    const first = samples[0];
    return {
      mode: 'fill',
      d: buildDotCirclePath(first.x, first.y, first.radius),
      color: stroke.color,
      opacity: effectiveOpacity,
      multiply: spec.multiply,
    };
  }

  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const nx = -s.ty;
    const ny = s.tx;
    left.push({ x: s.x + nx * s.radius, y: s.y + ny * s.radius });
    right.push({ x: s.x - nx * s.radius, y: s.y - ny * s.radius });
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const startRightAngle = Math.atan2(right[0].y - first.y, right[0].x - first.x);
  const startLeftAngle = Math.atan2(left[0].y - first.y, left[0].x - first.x);
  const endLeftAngle = Math.atan2(left[left.length - 1].y - last.y, left[left.length - 1].x - last.x);
  const endRightAngle = Math.atan2(right[right.length - 1].y - last.y, right[right.length - 1].x - last.x);

  const startCap = buildCapArc(first, startRightAngle, startLeftAngle, first.radius, 4);
  const endCap = buildCapArc(last, endLeftAngle, endRightAngle, last.radius, 4);

  const outline: Vec2[] = [
    ...startCap,
    ...left,
    ...endCap,
    ...right.reverse(),
  ];

  return {
    mode: 'fill',
    d: polygonToSmoothSvgPath(outline),
    color: stroke.color,
    opacity: effectiveOpacity,
    multiply: spec.multiply,
  };
}

export function hitTestStroke(
  stroke: InkStroke,
  px: number,
  py: number,
  eraserRadius: number,
  scaleX: number,
  scaleY: number,
): boolean {
  const pts = stroke.points;
  if (pts.length === 0) return false;
  const threshold = eraserRadius + stroke.width * 0.55;
  const thresholdSq = threshold * threshold;
  const qx = px * scaleX;
  const qy = py * scaleY;

  if (pts.length === 1) {
    const dx = qx - pts[0].x * scaleX;
    const dy = qy - pts[0].y * scaleY;
    return dx * dx + dy * dy <= thresholdSq;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x * scaleX;
    const ay = pts[i].y * scaleY;
    const bx = pts[i + 1].x * scaleX;
    const by = pts[i + 1].y * scaleY;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((qx - ax) * vx + (qy - ay) * vy) / lenSq));
    const cx = ax + t * vx;
    const cy = ay + t * vy;
    const dx = qx - cx;
    const dy = qy - cy;
    if (dx * dx + dy * dy <= thresholdSq) return true;
  }
  return false;
}

export interface StrokeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function getStrokeBoundingBox(
  stroke: InkStroke,
  scaleX: number,
  scaleY: number,
): StrokeBounds | null {
  const pts = stroke.points;
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const sx = pts[i].x * scaleX;
    const sy = pts[i].y * scaleY;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const pad = Math.max(2, stroke.width * 0.9);
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const ccw = (p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number) =>
    (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
  return (
    ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
    ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
  );
}

function segmentToSegmentDistSq(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointToSegmentDistSq(ax, ay, cx, cy, dx, dy),
    pointToSegmentDistSq(bx, by, cx, cy, dx, dy),
    pointToSegmentDistSq(cx, cy, ax, ay, bx, by),
    pointToSegmentDistSq(dx, dy, ax, ay, bx, by),
  );
}

function roundCoord(val: number, scale: number): number {
  if (scale > 10) return Math.round(val * 100000) / 100000;
  return Math.round(val * 100) / 100;
}

function toRawPoint(sx: number, sy: number, p: number | undefined, t: number | undefined, scaleX: number, scaleY: number): InkPoint {
  return {
    x: roundCoord(sx / scaleX, scaleX),
    y: roundCoord(sy / scaleY, scaleY),
    ...(p !== undefined ? { p: Math.round(p * 100) / 100 } : {}),
    ...(t !== undefined ? { t: Math.round(t) } : {}),
  };
}

interface ScaledSample {
  x: number;
  y: number;
  p?: number;
  t?: number;
}

function interpolateSample(a: ScaledSample, b: ScaledSample, u: number): ScaledSample {
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    ...(a.p !== undefined || b.p !== undefined ? { p: (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * u } : {}),
    ...(a.t !== undefined || b.t !== undefined ? { t: (a.t ?? 0) + ((b.t ?? 0) - (a.t ?? 0)) * u } : {}),
  };
}

function findBoundaryRatio(
  fromSample: ScaledSample,
  toSample: ScaledSample,
  fromInside: boolean,
  sax: number,
  say: number,
  sbx: number,
  sby: number,
  rSq: number,
): number {
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 6; iter++) {
    const mid = (lo + hi) * 0.5;
    const mx = fromSample.x + (toSample.x - fromSample.x) * mid;
    const my = fromSample.y + (toSample.y - fromSample.y) * mid;
    const midInside = pointToSegmentDistSq(mx, my, sax, say, sbx, sby) <= rSq;
    if (midInside === fromInside) lo = mid;
    else hi = mid;
  }
  return fromInside ? hi : lo;
}

/**
 * Pixel-like partial / segment eraser: removes only the portions of strokes
 * touched by the capsule (ax, ay) -> (bx, by) of radius `eraserRadius`, splitting
 * intersected strokes into clean separate segments while preserving untouched strokes.
 */
export function eraseStrokesAtSegment(
  strokes: readonly InkStroke[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  eraserRadius: number,
  scaleX: number,
  scaleY: number,
  makeId: () => string,
): { strokes: InkStroke[]; changed: boolean } {
  if (strokes.length === 0) return { strokes: strokes as InkStroke[], changed: false };

  const sax = ax * scaleX;
  const say = ay * scaleY;
  const sbx = bx * scaleX;
  const sby = by * scaleY;
  const segMinX = Math.min(sax, sbx);
  const segMaxX = Math.max(sax, sbx);
  const segMinY = Math.min(say, sby);
  const segMaxY = Math.max(say, sby);

  let changed = false;
  const result: InkStroke[] = [];
  const subStepLen = Math.max(2, Math.min(7, eraserRadius * 0.35));

  for (let si = 0; si < strokes.length; si++) {
    const stroke = strokes[si];
    const pts = stroke.points;
    if (pts.length === 0) {
      changed = true;
      continue;
    }

    const r = eraserRadius + stroke.width * 0.35;
    const rSq = r * r;

    // Fast AABB cull
    const bounds = getStrokeBoundingBox(stroke, scaleX, scaleY);
    if (
      !bounds ||
      bounds.maxX < segMinX - eraserRadius ||
      bounds.minX > segMaxX + eraserRadius ||
      bounds.maxY < segMinY - eraserRadius ||
      bounds.minY > segMaxY + eraserRadius
    ) {
      result.push(stroke);
      continue;
    }

    if (pts.length === 1) {
      const px = pts[0].x * scaleX;
      const py = pts[0].y * scaleY;
      if (pointToSegmentDistSq(px, py, sax, say, sbx, sby) <= rSq) {
        changed = true;
      } else {
        result.push(stroke);
      }
      continue;
    }

    // Subdivide long segments so thin lines & fast swipes cut smoothly right along the eraser boundary
    const dense: ScaledSample[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur: ScaledSample = {
        x: pts[i].x * scaleX,
        y: pts[i].y * scaleY,
        p: pts[i].p,
        t: pts[i].t,
      };
      if (i > 0) {
        const prev = dense[dense.length - 1];
        const segLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        if (segLen > subStepLen) {
          const steps = Math.min(400, Math.ceil(segLen / subStepLen));
          for (let step = 1; step < steps; step++) {
            dense.push(interpolateSample(prev, cur, step / steps));
          }
        }
      }
      dense.push(cur);
    }

    const inside = new Uint8Array(dense.length);
    let anyHit = false;
    for (let i = 0; i < dense.length; i++) {
      if (pointToSegmentDistSq(dense[i].x, dense[i].y, sax, say, sbx, sby) <= rSq) {
        inside[i] = 1;
        anyHit = true;
      }
    }

    // Check if any non-endpoint edge crosses through the capsule
    if (!anyHit) {
      for (let i = 0; i < dense.length - 1; i++) {
        if (
          segmentToSegmentDistSq(
            dense[i].x,
            dense[i].y,
            dense[i + 1].x,
            dense[i + 1].y,
            sax,
            say,
            sbx,
            sby,
          ) <= rSq
        ) {
          anyHit = true;
          break;
        }
      }
    }

    if (!anyHit) {
      result.push(stroke);
      continue;
    }

    changed = true;
    const pieces: ScaledSample[][] = [];
    let currentRun: ScaledSample[] = [];

    if (!inside[0]) {
      currentRun.push(dense[0]);
    }

    for (let i = 0; i < dense.length - 1; i++) {
      const a = dense[i];
      const b = dense[i + 1];
      const aIn = inside[i] === 1;
      const bIn = inside[i + 1] === 1;

      if (!aIn && !bIn) {
        if (segmentToSegmentDistSq(a.x, a.y, b.x, b.y, sax, say, sbx, sby) <= rSq) {
          // Rare edge crossing where both endpoints lie outside
          if (currentRun.length > 0) {
            currentRun.push(interpolateSample(a, b, 0.25));
            pieces.push(currentRun);
          }
          currentRun = [interpolateSample(a, b, 0.75), b];
        } else {
          if (currentRun.length === 0) currentRun.push(a);
          currentRun.push(b);
        }
      } else if (!aIn && bIn) {
        const u = findBoundaryRatio(a, b, false, sax, say, sbx, sby, rSq);
        if (u > 0.02) currentRun.push(interpolateSample(a, b, u));
        if (currentRun.length > 0) pieces.push(currentRun);
        currentRun = [];
      } else if (aIn && !bIn) {
        const u = findBoundaryRatio(a, b, true, sax, say, sbx, sby, rSq);
        currentRun = [];
        if (u < 0.98) currentRun.push(interpolateSample(a, b, u));
        currentRun.push(b);
      }
    }

    if (currentRun.length > 0) pieces.push(currentRun);

    let emittedIndex = 0;
    for (const run of pieces) {
      if (run.length < 2) continue;
      let totalRunLen = 0;
      for (let i = 1; i < run.length; i++) {
        totalRunLen += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
      }
      if (totalRunLen < 1.0) continue;

      const finalSamples = stroke.tool === 'line' ? [run[0], run[run.length - 1]] : run;
      const rawPoints = finalSamples.map((s) => toRawPoint(s.x, s.y, s.p, s.t, scaleX, scaleY));
      result.push({
        ...stroke,
        id: emittedIndex === 0 ? stroke.id : makeId(),
        points: rawPoints,
      });
      emittedIndex++;
    }
  }

  return { strokes: changed ? result : (strokes as InkStroke[]), changed };
}

export function appendPointFiltered(
  points: InkPoint[],
  next: InkPoint,
  minDist: number,
  scaleX: number,
  scaleY: number,
  maxPoints = 2000,
): InkPoint[] {
  if (points.length === 0) return [next];
  if (points.length >= maxPoints) {
    const kept = points.slice(0, maxPoints - 1);
    kept.push(next);
    return kept;
  }
  const last = points[points.length - 1];
  const dx = (next.x - last.x) * scaleX;
  const dy = (next.y - last.y) * scaleY;
  if (dx * dx + dy * dy < minDist * minDist) return points;
  return [...points, next];
}

export interface ResolvedPadLayout {
  topPads: HandwritingPad[];
  blockPads: Map<number, HandwritingPad[]>;
  bottomPads: HandwritingPad[];
  orphanedPads: HandwritingPad[];
}

export function normalizeAnchorText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function hastTextOf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: unknown; children?: unknown[] };
  if (n.type === 'text' && typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map((c) => hastTextOf(c)).join('');
  }
  return '';
}

export function extractBlockRefs(blocks: readonly unknown[] | undefined | null): InkBlockRef[] {
  if (!blocks || blocks.length === 0) return [];
  return blocks.map((block, index) => {
    const tagName =
      block && typeof block === 'object' && 'tagName' in block && typeof (block as { tagName?: unknown }).tagName === 'string'
        ? (block as { tagName: string }).tagName
        : 'block';
    return {
      index,
      text: normalizeAnchorText(hastTextOf(block)),
      tagName,
    };
  });
}

/** Build resilient anchor metadata when pinning a pad below any arbitrary block/line. */
export function buildBlockAnchor(
  blockIndex: number,
  headings: readonly InkHeadingRef[],
  blocks: readonly InkBlockRef[],
): Pick<HandwritingPad, 'anchorType' | 'anchorHeadingId' | 'anchorHeadingText' | 'anchorBlockIndex' | 'anchorBlockText' | 'anchorBlockOffset'> {
  const blockRef = blocks.find((b) => b.index === blockIndex);
  let nearestHeading: InkHeadingRef | null = null;
  for (const h of headings) {
    if (h.block <= blockIndex) nearestHeading = h;
    else break;
  }
  return {
    anchorType: 'block',
    anchorHeadingId: nearestHeading?.id ?? '',
    anchorHeadingText: nearestHeading?.text ?? '',
    anchorBlockIndex: blockIndex,
    anchorBlockText: blockRef?.text ?? '',
    anchorBlockOffset: nearestHeading ? Math.max(0, blockIndex - nearestHeading.block) : blockIndex,
  };
}

function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const left = counts.get(g) ?? 0;
    if (left > 0) {
      shared++;
      counts.set(g, left - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

function findMatchingHeading(pad: HandwritingPad, headings: readonly InkHeadingRef[]): InkHeadingRef | undefined {
  const byId = pad.anchorHeadingId ? headings.find((h) => h.id === pad.anchorHeadingId) : undefined;
  if (byId) return byId;
  const needle = pad.anchorHeadingText.trim();
  return needle ? headings.find((h) => h.text.trim() === needle) : undefined;
}

export function resolvePadAnchors(
  pads: readonly HandwritingPad[],
  headings: readonly InkHeadingRef[],
  blocks: readonly InkBlockRef[] = [],
): ResolvedPadLayout {
  const topPads: HandwritingPad[] = [];
  const blockPads = new Map<number, HandwritingPad[]>();
  const bottomPads: HandwritingPad[] = [];
  const orphanedPads: HandwritingPad[] = [];

  const attachBlock = (blockIndex: number, pad: HandwritingPad) => {
    const list = blockPads.get(blockIndex) ?? [];
    list.push(pad);
    blockPads.set(blockIndex, list);
  };

  for (const pad of pads) {
    if (typeof pad.deletedAt === 'number' && pad.deletedAt > 0) continue;

    if (pad.anchorType === 'top') {
      topPads.push(pad);
      continue;
    }
    if (pad.anchorType === 'bottom') {
      bottomPads.push(pad);
      continue;
    }

    if (pad.anchorType === 'block') {
      const matchedHeading = findMatchingHeading(pad, headings);
      const expectedIndex =
        matchedHeading && typeof pad.anchorBlockOffset === 'number'
          ? matchedHeading.block + pad.anchorBlockOffset
          : typeof pad.anchorBlockIndex === 'number'
            ? pad.anchorBlockIndex
            : 0;
      const needle = normalizeAnchorText(pad.anchorBlockText ?? '');

      // Tier 1: Exact normalized block text match (closest to expected index when duplicated)
      if (needle && blocks.length > 0) {
        const exact = blocks.filter((b) => b.text === needle);
        if (exact.length > 0) {
          exact.sort((a, b) => Math.abs(a.index - expectedIndex) - Math.abs(b.index - expectedIndex));
          attachBlock(exact[0].index, pad);
          continue;
        }
        // Tier 2: Fuzzy similarity match within nearby blocks if the line was slightly edited
        if (needle.length >= 6) {
          let bestIdx = -1;
          let bestScore = 0.55;
          for (const b of blocks) {
            if (!b.text || Math.abs(b.index - expectedIndex) > 20) continue;
            const score = bigramSimilarity(needle, b.text);
            if (score > bestScore) {
              bestScore = score;
              bestIdx = b.index;
            }
          }
          if (bestIdx >= 0) {
            attachBlock(bestIdx, pad);
            continue;
          }
        }
      }

      // Tier 3: Heading + relative block offset
      if (matchedHeading && typeof pad.anchorBlockOffset === 'number') {
        const idx = matchedHeading.block + pad.anchorBlockOffset;
        if (blocks.length === 0 || (idx >= 0 && idx < blocks.length)) {
          attachBlock(idx, pad);
          continue;
        }
      }

      // Tier 4: Original block index if within bounds
      if (typeof pad.anchorBlockIndex === 'number' && pad.anchorBlockIndex >= 0 && pad.anchorBlockIndex < blocks.length) {
        attachBlock(pad.anchorBlockIndex, pad);
        continue;
      }

      // Tier 5: Preserve in orphaned section so ink is never lost
      orphanedPads.push(pad);
      continue;
    }

    // Legacy 'heading' anchor
    const matched = findMatchingHeading(pad, headings);
    if (matched) {
      attachBlock(matched.block, pad);
    } else {
      orphanedPads.push(pad);
    }
  }

  return { topPads, blockPads, bottomPads, orphanedPads };
}

export interface BlockLayoutOffset {
  index: number;
  start: number;
  size: number;
}

function roundBlockY(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Find the Markdown virtual block covering a document Y coordinate so temp ink stays anchored across virtualizer re-measurements. */
export function findAnchorBlockForY(
  y: number,
  blockOffsets: readonly BlockLayoutOffset[],
): { anchorBlockIndex: number; anchorBlockTop: number } | null {
  if (!blockOffsets || blockOffsets.length === 0) return null;
  let lo = 0;
  let hi = blockOffsets.length - 1;
  let best = blockOffsets[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = blockOffsets[mid];
    if (y < item.start) {
      hi = mid - 1;
    } else if (y > item.start + item.size) {
      best = item;
      lo = mid + 1;
    } else {
      return { anchorBlockIndex: item.index, anchorBlockTop: roundBlockY(item.start) };
    }
  }
  return { anchorBlockIndex: best.index, anchorBlockTop: roundBlockY(best.start) };
}

/** Compute the live Y offset shift (in CSS px) for a block-anchored stroke relative to when it was captured. */
export function resolveAnchoredStrokeYOffset(
  stroke: Pick<InkStroke, 'anchorBlockIndex' | 'anchorBlockTop'>,
  blockOffsets: readonly BlockLayoutOffset[],
): number {
  if (
    typeof stroke.anchorBlockIndex !== 'number' ||
    typeof stroke.anchorBlockTop !== 'number' ||
    !Number.isFinite(stroke.anchorBlockTop) ||
    !blockOffsets ||
    blockOffsets.length === 0
  ) {
    return 0;
  }
  const idx = stroke.anchorBlockIndex;
  const direct = idx >= 0 && idx < blockOffsets.length && blockOffsets[idx].index === idx ? blockOffsets[idx] : undefined;
  const live = direct ?? blockOffsets.find((b) => b.index === idx);
  if (!live) return 0;
  const delta = live.start - stroke.anchorBlockTop;
  return Math.abs(delta) < 0.25 ? 0 : roundBlockY(delta);
}

/** Shift block-anchored strokes into the current virtualizer block positions so scrolling/re-measuring never misaligns ink. */
export function resolveAnchoredStrokes(
  strokes: readonly InkStroke[],
  blockOffsets: readonly BlockLayoutOffset[],
): InkStroke[] {
  if (!blockOffsets || blockOffsets.length === 0 || strokes.length === 0) {
    return strokes as InkStroke[];
  }
  let anyChanged = false;
  const out: InkStroke[] = new Array(strokes.length);
  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    const deltaY = resolveAnchoredStrokeYOffset(st, blockOffsets);
    if (deltaY === 0) {
      out[i] = st;
      continue;
    }
    anyChanged = true;
    const nextPoints: InkPoint[] = st.points.map((pt) => ({
      ...pt,
      y: roundBlockY(Math.max(0, pt.y + deltaY)),
    }));
    out[i] = {
      ...st,
      anchorBlockTop: roundBlockY(st.anchorBlockTop! + deltaY),
      points: nextPoints,
    };
  }
  return anyChanged ? out : (strokes as InkStroke[]);
}
