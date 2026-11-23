export type InkBrushId = 'fountain' | 'ballpoint' | 'pencil' | 'marker' | 'highlight' | 'line';
export type InkToolKind = InkBrushId | 'pen';
export type InkActiveTool = 'browse' | InkBrushId | 'eraser';
export type InkEraserMode = 'partial' | 'stroke';
export type PadBackground = 'blank' | 'grid' | 'ruled' | 'dot';
export type PadAnchorType = 'top' | 'heading' | 'block' | 'bottom';

export interface InkPoint {
  x: number;
  y: number;
  /** Stylus / simulated pressure 0..1 */
  p?: number;
  /** Relative timestamp in ms from stroke start (used for velocity-based feel when pressure is flat) */
  t?: number;
}

export interface InkStroke {
  id: string;
  tool: InkToolKind;
  color: string;
  width: number;
  opacity?: number;
  /** 0..1.5 multiplier controlling how strongly pressure affects stroke thickness */
  pressureSensitivity?: number;
  /** Optional virtual-block anchor for TempInkOverlay strokes so ink stays aligned when blocks re-measure */
  anchorBlockIndex?: number;
  /** Document Y of the anchored block's top when this stroke's points were captured */
  anchorBlockTop?: number;
  points: InkPoint[];
}

export interface HandwritingPad {
  id: string;
  title: string;
  anchorType: PadAnchorType;
  anchorHeadingId: string;
  anchorHeadingText: string;
  /** Target block index at creation/move time (for 'block' anchors) */
  anchorBlockIndex?: number;
  /** Normalized text snippet of the anchored block/line so it survives MD edits */
  anchorBlockText?: string;
  /** Relative block offset after anchorHeadingId (fallback if block text was edited) */
  anchorBlockOffset?: number;
  logicalHeight: number;
  background: PadBackground;
  collapsed: boolean;
  strokes: InkStroke[];
  createdAt: number;
  updatedAt: number;
  /** Tombstone timestamp (ms) when deleted, preserved for conflict-free cross-device sync */
  deletedAt?: number;
}

export interface InkBlockRef {
  index: number;
  text: string;
  tagName: string;
}

export interface InkHeadingRef {
  id: string;
  text: string;
  depth: number;
  block: number;
}

export interface InkLoadResult {
  pads: HandwritingPad[];
  tempStrokes: InkStroke[];
  tempClearedByChange: boolean;
}

export interface PenBrushSpec {
  id: InkBrushId;
  label: string;
  desc: string;
  defaultColor: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  widthPresets: readonly [number, number, number, number, number];
  defaultOpacity: number;
  /** Minimum thickness multiplier at light pressure */
  minScale: number;
  /** Maximum thickness multiplier at heavy pressure */
  maxScale: number;
  /** Exponential smoothing 0..0.6 for hand stabilization */
  streamline: number;
  /** Taper distance in output units at start/end of stroke */
  taperStart: number;
  taperEnd: number;
  /** Optional chisel nib angle in radians (e.g. marker) */
  chiselAngleRad?: number;
  /** Whether brush uses multiply blend mode so underlying text stays legible */
  multiply?: boolean;
  /** Whether light pressure also softens opacity (e.g. pencil) */
  pressureOpacity?: boolean;
}

export interface PenProfile {
  color: string;
  width: number;
  opacity: number;
  pressureSensitivity: number;
}

export const PEN_BRUSH_SPECS: Record<InkBrushId, PenBrushSpec> = {
  fountain: {
    id: 'fountain',
    label: '钢笔',
    desc: '自然笔锋，跟手低延迟',
    defaultColor: '#0F172A',
    defaultWidth: 3.6,
    minWidth: 1.4,
    maxWidth: 14,
    widthPresets: [2.0, 2.8, 3.6, 5.2, 7.6],
    defaultOpacity: 1.0,
    minScale: 0.4,
    maxScale: 1.56,
    streamline: 0.1,
    taperStart: 8,
    taperEnd: 14,
  },
  ballpoint: {
    id: 'ballpoint',
    label: '圆珠笔',
    desc: '顺滑精准，适合密集汉字书写',
    defaultColor: '#1D4ED8',
    defaultWidth: 2.6,
    minWidth: 1.2,
    maxWidth: 10,
    widthPresets: [1.6, 2.2, 2.6, 3.8, 5.6],
    defaultOpacity: 0.98,
    minScale: 0.84,
    maxScale: 1.16,
    streamline: 0.08,
    taperStart: 3,
    taperEnd: 5,
  },
  pencil: {
    id: 'pencil',
    label: '铅笔',
    desc: '轻柔素描质感，重压加深',
    defaultColor: '#334155',
    defaultWidth: 3.2,
    minWidth: 1.4,
    maxWidth: 14,
    widthPresets: [1.8, 2.4, 3.2, 4.8, 7.2],
    defaultOpacity: 0.74,
    minScale: 0.65,
    maxScale: 1.32,
    streamline: 0.06,
    taperStart: 5,
    taperEnd: 8,
    pressureOpacity: true,
  },
  marker: {
    id: 'marker',
    label: '马克笔',
    desc: '斜扁饱满笔触，叠色强调',
    defaultColor: '#DC2626',
    defaultWidth: 10.5,
    minWidth: 4,
    maxWidth: 28,
    widthPresets: [6, 8.5, 10.5, 15, 22],
    defaultOpacity: 0.84,
    minScale: 0.82,
    maxScale: 1.22,
    streamline: 0.12,
    taperStart: 2,
    taperEnd: 4,
    chiselAngleRad: (35 * Math.PI) / 180,
    multiply: true,
  },
  highlight: {
    id: 'highlight',
    label: '荧光笔',
    desc: '半透明宽幅高亮，不遮正文',
    defaultColor: '#FDE047',
    defaultWidth: 24,
    minWidth: 10,
    maxWidth: 44,
    widthPresets: [14, 18, 24, 30, 38],
    defaultOpacity: 0.36,
    minScale: 0.92,
    maxScale: 1.08,
    streamline: 0.14,
    taperStart: 0,
    taperEnd: 0,
    multiply: true,
  },
  line: {
    id: 'line',
    label: '直线',
    desc: '精准辅助线、下划线与坐标轴',
    defaultColor: '#0F766E',
    defaultWidth: 2.8,
    minWidth: 1.2,
    maxWidth: 14,
    widthPresets: [1.6, 2.2, 2.8, 4.5, 7.0],
    defaultOpacity: 1.0,
    minScale: 1,
    maxScale: 1,
    streamline: 0,
    taperStart: 0,
    taperEnd: 0,
  },
};

export const PEN_BRUSH_ORDER: readonly InkBrushId[] = [
  'fountain',
  'ballpoint',
  'pencil',
  'marker',
  'highlight',
  'line',
];

export function resolveBrushSpec(tool: InkToolKind): PenBrushSpec {
  if (tool === 'pen') return PEN_BRUSH_SPECS.fountain;
  return PEN_BRUSH_SPECS[tool] ?? PEN_BRUSH_SPECS.fountain;
}

export function createDefaultPenProfiles(widthScale = 1): Record<InkBrushId, PenProfile> {
  const out = {} as Record<InkBrushId, PenProfile>;
  for (const id of PEN_BRUSH_ORDER) {
    const spec = PEN_BRUSH_SPECS[id];
    out[id] = {
      color: spec.defaultColor,
      width: Math.round(spec.defaultWidth * widthScale * 10) / 10,
      opacity: spec.defaultOpacity,
      pressureSensitivity: 1.0,
    };
  }
  return out;
}

export const INK_COLORS = [
  '#0F172A',
  '#334155',
  '#0F766E',
  '#1D4ED8',
  '#DC2626',
  '#D97706',
  '#7C3AED',
  '#16A34A',
] as const;

export const HIGHLIGHT_COLORS = [
  '#FDE047',
  '#86EFAC',
  '#93C5FD',
  '#F9A8D4',
  '#FDBA74',
  '#C4B5FD',
] as const;

export const EXTENDED_INK_COLORS = [
  // Row 1: Classic dark & study inks
  '#0F172A', '#334155', '#475569', '#64748B', '#78350F', '#1E3A8A',
  // Row 2: Rich pen colors
  '#0F766E', '#0D9488', '#1D4ED8', '#2563EB', '#7C3AED', '#9333EA',
  // Row 3: Correction & emphasis
  '#DC2626', '#E11D48', '#EA580C', '#D97706', '#16A34A', '#059669',
  // Row 4: Soft pastel & highlighter tints
  '#FDE047', '#FDBA74', '#F9A8D4', '#C4B5FD', '#93C5FD', '#86EFAC',
] as const;

export const PAD_BACKGROUNDS: { id: PadBackground; label: string }[] = [
  { id: 'blank', label: '白纸' },
  { id: 'grid', label: '网格' },
  { id: 'ruled', label: '横线' },
  { id: 'dot', label: '点阵' },
];
