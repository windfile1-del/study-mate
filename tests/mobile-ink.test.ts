import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPointFiltered,
  buildBlockAnchor,
  buildStrokeRenderData,
  computeVariableStrokeSamples,
  eraseStrokesAtSegment,
  extractBlockRefs,
  findAnchorBlockForY,
  getStrokeBoundingBox,
  hasRealPressureData,
  hitTestStroke,
  resolveAnchoredStrokes,
  resolveAnchoredStrokeYOffset,
  resolvePadAnchors,
  strokeToSvgPath,
} from '../apps/mobile/reader/ink-geometry';
import {
  activeHandwritingPads,
  mergeHandwritingPads,
} from '../apps/desktop/src/shared/note-ink';
import {
  createDefaultPenProfiles,
  PEN_BRUSH_SPECS,
  resolveBrushSpec,
  type HandwritingPad,
  type InkHeadingRef,
  type InkStroke,
} from '../apps/mobile/reader/ink-types';

function makePad(partial: Partial<HandwritingPad>): HandwritingPad {
  return {
    id: partial.id ?? 'pad-1',
    title: partial.title ?? '手写笔记',
    anchorType: partial.anchorType ?? 'bottom',
    anchorHeadingId: partial.anchorHeadingId ?? '',
    anchorHeadingText: partial.anchorHeadingText ?? '',
    ...(partial.anchorBlockIndex !== undefined ? { anchorBlockIndex: partial.anchorBlockIndex } : {}),
    ...(partial.anchorBlockText !== undefined ? { anchorBlockText: partial.anchorBlockText } : {}),
    ...(partial.anchorBlockOffset !== undefined ? { anchorBlockOffset: partial.anchorBlockOffset } : {}),
    logicalHeight: partial.logicalHeight ?? 420,
    background: partial.background ?? 'grid',
    collapsed: partial.collapsed ?? false,
    strokes: partial.strokes ?? [],
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    ...(partial.deletedAt !== undefined ? { deletedAt: partial.deletedAt } : {}),
  };
}

test('strokeToSvgPath handles empty, single dot, two-point line, and smooth quadratic curve', () => {
  assert.equal(strokeToSvgPath([], 1000, 1), '');
  assert.equal(strokeToSvgPath([{ x: 0.5, y: 120 }], 1000, 1), 'M 500 120 L 500.05 120.05');
  assert.equal(
    strokeToSvgPath(
      [
        { x: 0.1, y: 10 },
        { x: 0.4, y: 50 },
      ],
      1000,
      1,
    ),
    'M 100 10 L 400 50',
  );
  const curve = strokeToSvgPath(
    [
      { x: 0, y: 0 },
      { x: 0.1, y: 20 },
      { x: 0.2, y: 40 },
    ],
    1000,
    1,
  );
  assert.match(curve, /^M 0 0 Q 100 20 150 30 L 200 40$/);
});

test('hitTestStroke detects segment hits, single-dot hits, and misses', () => {
  const segStroke: InkStroke = {
    id: 's1',
    tool: 'pen',
    color: '#0F172A',
    width: 4,
    points: [
      { x: 0.1, y: 100 },
      { x: 0.5, y: 100 },
    ],
  };
  assert.equal(hitTestStroke(segStroke, 0.3, 106, 12, 1000, 1), true);
  assert.equal(hitTestStroke(segStroke, 0.3, 130, 12, 1000, 1), false);

  const dotStroke: InkStroke = {
    id: 's2',
    tool: 'pen',
    color: '#0F766E',
    width: 6,
    points: [{ x: 0.25, y: 200 }],
  };
  assert.equal(hitTestStroke(dotStroke, 0.255, 205, 10, 1000, 1), true);
  assert.equal(hitTestStroke(dotStroke, 0.35, 240, 10, 1000, 1), false);
});

test('appendPointFiltered drops overly dense points and respects maxPoints limit', () => {
  const pts1 = appendPointFiltered([{ x: 0.1, y: 10 }], { x: 0.1005, y: 10.5 }, 2, 1000, 1);
  assert.equal(pts1.length, 1);

  const pts2 = appendPointFiltered(pts1, { x: 0.12, y: 20 }, 2, 1000, 1);
  assert.equal(pts2.length, 2);

  const full = [
    { x: 0, y: 0 },
    { x: 0.1, y: 10 },
    { x: 0.2, y: 20 },
  ];
  const capped = appendPointFiltered(full, { x: 0.9, y: 90 }, 2, 1000, 1, 3);
  assert.equal(capped.length, 3);
  assert.deepEqual(capped[2], { x: 0.9, y: 90 });
});

test('resolvePadAnchors maps top, heading id, heading text fallback, bottom, and preserves orphaned pads', () => {
  const headings: InkHeadingRef[] = [
    { id: 'sec-intro', text: '引言', depth: 1, block: 1 },
    { id: 'sec-renamed-id', text: '微积分重点', depth: 2, block: 5 },
  ];
  const topPad = makePad({ id: 'p-top', anchorType: 'top' });
  const idPad = makePad({
    id: 'p-id',
    anchorType: 'heading',
    anchorHeadingId: 'sec-intro',
    anchorHeadingText: '旧名称',
  });
  const textFallbackPad = makePad({
    id: 'p-text',
    anchorType: 'heading',
    anchorHeadingId: 'deleted-id',
    anchorHeadingText: ' 微积分重点 ',
  });
  const orphanPad = makePad({
    id: 'p-orphan',
    anchorType: 'heading',
    anchorHeadingId: 'gone-id',
    anchorHeadingText: '已删除小节',
  });
  const bottomPad = makePad({ id: 'p-bottom', anchorType: 'bottom' });

  const resolved = resolvePadAnchors([topPad, idPad, textFallbackPad, orphanPad, bottomPad], headings);
  assert.deepEqual(
    resolved.topPads.map((p) => p.id),
    ['p-top'],
  );
  assert.deepEqual(
    resolved.blockPads.get(1)?.map((p) => p.id),
    ['p-id'],
  );
  assert.deepEqual(
    resolved.blockPads.get(5)?.map((p) => p.id),
    ['p-text'],
  );
  assert.deepEqual(
    resolved.bottomPads.map((p) => p.id),
    ['p-bottom'],
  );
  assert.deepEqual(
    resolved.orphanedPads.map((p) => p.id),
    ['p-orphan'],
  );
});

test('hasRealPressureData distinguishes true stylus pressure from constant finger/mouse defaults', () => {
  assert.equal(
    hasRealPressureData([
      { x: 0, y: 0, p: 0.5 },
      { x: 10, y: 10, p: 0.5 },
    ]),
    false,
  );
  assert.equal(
    hasRealPressureData([
      { x: 0, y: 0, p: 1.0 },
      { x: 10, y: 10, p: 1.0 },
    ]),
    false,
  );
  assert.equal(
    hasRealPressureData([
      { x: 0, y: 0, p: 0.25 },
      { x: 10, y: 10, p: 0.72 },
    ]),
    true,
  );
});

test('computeVariableStrokeSamples varies stroke radius with real pressure and brush dynamic range', () => {
  const lightPoints = Array.from({ length: 12 }, (_, i) => ({ x: i * 16, y: 50, p: 0.16, t: i * 12 }));
  const heavyPoints = Array.from({ length: 12 }, (_, i) => ({ x: i * 16, y: 50, p: 0.92, t: i * 12 }));

  const fountainLight = computeVariableStrokeSamples(lightPoints, PEN_BRUSH_SPECS.fountain, 4, 1, 1, 1.0);
  const fountainHeavy = computeVariableStrokeSamples(heavyPoints, PEN_BRUSH_SPECS.fountain, 4, 1, 1, 1.0);
  const midIdx = Math.floor(fountainLight.samples.length / 2);
  const lightMidR = fountainLight.samples[midIdx].radius;
  const heavyMidR = fountainHeavy.samples[midIdx].radius;
  assert.ok(heavyMidR > lightMidR * 1.6, `expected heavy fountain radius (${heavyMidR}) >> light (${lightMidR})`);

  const ballLight = computeVariableStrokeSamples(lightPoints, PEN_BRUSH_SPECS.ballpoint, 4, 1, 1, 1.0);
  const ballHeavy = computeVariableStrokeSamples(heavyPoints, PEN_BRUSH_SPECS.ballpoint, 4, 1, 1, 1.0);
  const fountainRatio = heavyMidR / lightMidR;
  const ballRatio =
    ballHeavy.samples[Math.floor(ballHeavy.samples.length / 2)].radius /
    ballLight.samples[Math.floor(ballLight.samples.length / 2)].radius;
  assert.ok(fountainRatio > ballRatio, `expected fountain ratio (${fountainRatio}) > ballpoint ratio (${ballRatio})`);
});

test('computeVariableStrokeSamples simulates thicker strokes for slower movement when pressure is constant', () => {
  const slowPoints = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: 60, p: 0.5, t: i * 45 }));
  const fastPoints = Array.from({ length: 12 }, (_, i) => ({ x: i * 35, y: 60, p: 0.5, t: i * 10 }));

  const slow = computeVariableStrokeSamples(slowPoints, PEN_BRUSH_SPECS.fountain, 4, 1, 1, 1.0);
  const fast = computeVariableStrokeSamples(fastPoints, PEN_BRUSH_SPECS.fountain, 4, 1, 1, 1.0);
  const slowMid = slow.samples[Math.floor(slow.samples.length / 2)].radius;
  const fastMid = fast.samples[Math.floor(fast.samples.length / 2)].radius;
  assert.ok(slowMid > fastMid * 1.15, `expected slow stroke radius (${slowMid}) > fast stroke radius (${fastMid})`);
});

test('buildStrokeRenderData handles all pen types, legacy pen compatibility, pencil opacity, and single dots', () => {
  const curve = [
    { x: 10, y: 20, p: 0.25, t: 0 },
    { x: 40, y: 28, p: 0.65, t: 16 },
    { x: 80, y: 40, p: 0.85, t: 32 },
    { x: 120, y: 36, p: 0.3, t: 48 },
  ];

  // Legacy 'pen' resolves to fountain pen and produces a closed filled outline
  assert.equal(resolveBrushSpec('pen').id, 'fountain');
  const legacy = buildStrokeRenderData({ id: 'l1', tool: 'pen', color: '#0F172A', width: 4, points: curve }, 1, 1);
  assert.equal(legacy.mode, 'fill');
  assert.match(legacy.d, /^M .* Z$/);

  // Pencil modulates opacity based on pressure
  const pencilLight = buildStrokeRenderData(
    {
      id: 'p1',
      tool: 'pencil',
      color: '#334155',
      width: 3,
      opacity: 0.8,
      points: curve.map((pt) => ({ ...pt, p: 0.15 })),
    },
    1,
    1,
  );
  const pencilHeavy = buildStrokeRenderData(
    {
      id: 'p2',
      tool: 'pencil',
      color: '#334155',
      width: 3,
      opacity: 0.8,
      points: curve.map((pt) => ({ ...pt, p: 0.9 })),
    },
    1,
    1,
  );
  assert.equal(pencilLight.mode, 'fill');
  assert.ok(pencilHeavy.opacity > pencilLight.opacity, 'heavier pencil pressure should darken opacity');

  // Marker uses multiply blend + filled chisel outline
  const marker = buildStrokeRenderData({ id: 'm1', tool: 'marker', color: '#0F766E', width: 9, points: curve }, 1, 1);
  assert.equal(marker.mode, 'fill');
  assert.equal(marker.multiply, true);

  // Highlight and line stay crisp stroke mode; highlight uses butt cap + multiply
  const highlight = buildStrokeRenderData(
    { id: 'h1', tool: 'highlight', color: '#FDE047', width: 18, points: curve },
    1,
    1,
  );
  assert.equal(highlight.mode, 'stroke');
  assert.equal(highlight.linecap, 'butt');
  assert.equal(highlight.multiply, true);

  const line = buildStrokeRenderData(
    { id: 'ln1', tool: 'line', color: '#2563EB', width: 3, points: [curve[0], curve[3]] },
    1,
    1,
  );
  assert.equal(line.mode, 'stroke');
  assert.equal(line.linecap, 'round');

  // Single-point tap renders a closed circular dot path
  const dot = buildStrokeRenderData(
    { id: 'd1', tool: 'ballpoint', color: '#0F172A', width: 4, points: [{ x: 100, y: 120, p: 0.6 }] },
    1,
    1,
  );
  assert.equal(dot.mode, 'fill');
  assert.match(dot.d, /^M .* A .* A .* Z$/);

  // Default profiles exist for all brushes with distinct sensible defaults
  const profiles = createDefaultPenProfiles(1);
  assert.ok(profiles.highlight.width > profiles.marker.width);
  assert.ok(profiles.marker.width > profiles.fountain.width);
  assert.ok(profiles.fountain.pressureSensitivity >= 1.0);
});

test('resolvePadAnchors supports arbitrary-line block anchors resilient to MD edits and filters tombstones', () => {
  const headings: InkHeadingRef[] = [
    { id: 'sec-1', text: '线性代数', depth: 1, block: 0 },
    { id: 'sec-2', text: '特征值分解', depth: 2, block: 3 },
  ];
  const initialBlocks = [
    { type: 'element', tagName: 'h1', children: [{ type: 'text', value: '线性代数' }] },
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '矩阵乘法满足结合律但不满足交换律。' }] },
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '行列式用于判断矩阵是否可逆。' }] },
    { type: 'element', tagName: 'h2', children: [{ type: 'text', value: '特征值分解' }] },
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '如果 Ax = λx，则 λ 为矩阵的特征值。' }] },
  ];
  const refsBefore = extractBlockRefs(initialBlocks);
  assert.equal(refsBefore.length, 5);
  assert.equal(refsBefore[4].text, '如果 Ax = λx，则 λ 为矩阵的特征值。');

  const anchor = buildBlockAnchor(4, headings, refsBefore);
  assert.equal(anchor.anchorType, 'block');
  assert.equal(anchor.anchorHeadingId, 'sec-2');
  assert.equal(anchor.anchorBlockOffset, 1);

  const blockPad = makePad({ id: 'p-block', ...anchor });
  const deletedPad = makePad({ id: 'p-deleted', anchorType: 'top', deletedAt: 1000 });

  // After inserting two paragraphs above and fixing a tiny typo in the target line:
  const editedBlocks = [
    initialBlocks[0],
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '新增前置说明一' }] },
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '新增前置说明二' }] },
    initialBlocks[1],
    initialBlocks[2],
    initialBlocks[3],
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '如果 Ax = λx，则 λ 称为矩阵的特征值。' }] },
  ];
  const editedHeadings: InkHeadingRef[] = [
    { id: 'sec-1', text: '线性代数', depth: 1, block: 0 },
    { id: 'sec-2', text: '特征值分解', depth: 2, block: 5 },
  ];
  const refsAfter = extractBlockRefs(editedBlocks);

  const resolved = resolvePadAnchors([blockPad, deletedPad], editedHeadings, refsAfter);
  assert.equal(resolved.topPads.length, 0, 'deleted tombstones should not render');
  assert.deepEqual(
    resolved.blockPads.get(6)?.map((p) => p.id),
    ['p-block'],
    'block-anchored pad should follow its line after MD insertions and minor edit',
  );
  assert.equal(resolved.orphanedPads.length, 0);
});

test('mergeHandwritingPads performs conflict-free per-pad LWW merge and preserves tombstones', () => {
  const now = 1_000_000;
  const tabletOnly = makePad({ id: 'pad-tablet', title: '平板手写', createdAt: now - 500, updatedAt: now - 100 });
  const desktopOnly = makePad({ id: 'pad-desktop', title: '桌面手写', createdAt: now - 400, updatedAt: now - 200 });
  const sharedOlder = makePad({ id: 'pad-shared', title: '旧标题', createdAt: now - 600, updatedAt: now - 300 });
  const sharedNewer = makePad({ id: 'pad-shared', title: '新标题', createdAt: now - 600, updatedAt: now - 50 });
  const aliveOld = makePad({ id: 'pad-del', title: '将删除', createdAt: now - 700, updatedAt: now - 400 });
  const deletedNew = makePad({
    id: 'pad-del',
    title: '将删除',
    createdAt: now - 700,
    updatedAt: now - 20,
    deletedAt: now - 20,
    strokes: [],
  });

  const merged = mergeHandwritingPads([desktopOnly, sharedOlder, aliveOld], [tabletOnly, sharedNewer, deletedNew], now);
  assert.deepEqual(
    merged.map((p) => p.id),
    ['pad-del', 'pad-shared', 'pad-tablet', 'pad-desktop'],
  );
  assert.equal(merged.find((p) => p.id === 'pad-shared')?.title, '新标题');
  assert.equal(merged.find((p) => p.id === 'pad-del')?.deletedAt, now - 20);
  assert.deepEqual(
    activeHandwritingPads(merged).map((p) => p.id),
    ['pad-shared', 'pad-tablet', 'pad-desktop'],
  );
});

test('getStrokeBoundingBox computes padded axis-aligned bounds', () => {
  const stroke: InkStroke = {
    id: 'bb-1',
    tool: 'fountain',
    color: '#0F172A',
    width: 10,
    points: [
      { x: 50, y: 100 },
      { x: 150, y: 220 },
    ],
  };
  const bb = getStrokeBoundingBox(stroke, 1, 1);
  assert.ok(bb !== null);
  assert.equal(bb.minX, 41);
  assert.equal(bb.maxX, 159);
  assert.equal(bb.minY, 91);
  assert.equal(bb.maxY, 229);
  assert.equal(getStrokeBoundingBox({ ...stroke, points: [] }, 1, 1), null);
});

test('eraseStrokesAtSegment performs true partial erasing: middle split, line split, endpoint trim, fast capsule crossing, and dot removal', () => {
  let seq = 0;
  const makeId = () => `split-${++seq}`;

  const horizStroke: InkStroke = {
    id: 's-horiz',
    tool: 'fountain',
    color: '#0F172A',
    width: 4,
    opacity: 0.95,
    pressureSensitivity: 1.1,
    points: Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: 100, p: 0.5 + i * 0.01, t: i * 10 })),
  };
  const untouchedStroke: InkStroke = {
    id: 's-far',
    tool: 'pencil',
    color: '#334155',
    width: 3,
    points: [
      { x: 20, y: 400 },
      { x: 120, y: 400 },
    ],
  };

  // 1. Cut out the middle (x=100, y=100, radius=20) -> leaves left (0..~78.6) and right (~121.4..200)
  const splitRes = eraseStrokesAtSegment([horizStroke, untouchedStroke], 100, 100, 100, 100, 20, 1, 1, makeId);
  assert.equal(splitRes.changed, true);
  assert.equal(splitRes.strokes.length, 3, 'horizontal stroke should split into 2 pieces plus 1 untouched stroke');
  assert.strictEqual(splitRes.strokes[2], untouchedStroke, 'untouched stroke must preserve exact object reference');
  const [leftPiece, rightPiece] = splitRes.strokes;
  assert.equal(leftPiece.id, 's-horiz');
  assert.equal(rightPiece.id, 'split-1');
  assert.equal(leftPiece.tool, 'fountain');
  assert.equal(leftPiece.pressureSensitivity, 1.1);
  assert.ok(leftPiece.points[leftPiece.points.length - 1].x <= 82);
  assert.ok(rightPiece.points[0].x >= 118);

  // 2. Straight 'line' stroke split stays simplified to 2-point lines on each side
  const lineStroke: InkStroke = {
    id: 's-line',
    tool: 'line',
    color: '#0F766E',
    width: 3,
    points: [
      { x: 0, y: 200 },
      { x: 300, y: 200 },
    ],
  };
  const lineSplit = eraseStrokesAtSegment([lineStroke], 150, 180, 150, 220, 18, 1, 1, makeId);
  assert.equal(lineSplit.changed, true);
  assert.equal(lineSplit.strokes.length, 2);
  assert.equal(lineSplit.strokes[0].points.length, 2);
  assert.equal(lineSplit.strokes[1].points.length, 2);
  assert.ok(lineSplit.strokes[0].points[1].x < 135);
  assert.ok(lineSplit.strokes[1].points[0].x > 165);

  // 3. Fast vertical eraser swipe crosses horizontal segment between x=100..200 without skipping
  const fastSwipe = eraseStrokesAtSegment([lineStroke], 100, 120, 100, 280, 10, 1, 1, makeId);
  assert.equal(fastSwipe.changed, true);
  assert.equal(fastSwipe.strokes.length, 2);

  // 4. Endpoint trim + single-dot removal
  const trimRes = eraseStrokesAtSegment([horizStroke], 0, 100, 0, 100, 25, 1, 1, makeId);
  assert.equal(trimRes.changed, true);
  assert.equal(trimRes.strokes.length, 1);
  assert.ok(trimRes.strokes[0].points[0].x >= 22);

  const dotStroke: InkStroke = {
    id: 's-dot',
    tool: 'ballpoint',
    color: '#1D4ED8',
    width: 4,
    points: [{ x: 50, y: 50 }],
  };
  const dotErase = eraseStrokesAtSegment([dotStroke], 55, 52, 55, 52, 10, 1, 1, makeId);
  assert.equal(dotErase.changed, true);
  assert.equal(dotErase.strokes.length, 0);
});

test('block-anchored temp strokes stay aligned when virtualizer re-measures upstream blocks', () => {
  const initialOffsets = [
    { index: 0, start: 0, size: 100 },
    { index: 1, start: 100, size: 100 },
    { index: 2, start: 200, size: 120 },
  ];

  const anchor = findAnchorBlockForY(245, initialOffsets);
  assert.deepEqual(anchor, { anchorBlockIndex: 2, anchorBlockTop: 200 });

  const stroke: InkStroke = {
    id: 'tmp-1',
    tool: 'fountain',
    color: '#0F172A',
    width: 3,
    ...anchor!,
    points: [
      { x: 0.2, y: 245, p: 0.5, t: 0 },
      { x: 0.5, y: 260, p: 0.6, t: 16 },
    ],
  };

  // No shift when block 2 stays at 200 -> returns original array reference
  assert.equal(resolveAnchoredStrokeYOffset(stroke, initialOffsets), 0);
  const unchanged = resolveAnchoredStrokes([stroke], initialOffsets);
  assert.equal(unchanged[0], stroke);

  // Block 0 expands by +180px after virtualizer measurement or <details> expansion -> block 2 moves to 380
  const shiftedOffsets = [
    { index: 0, start: 0, size: 280 },
    { index: 1, start: 280, size: 100 },
    { index: 2, start: 380, size: 120 },
  ];
  assert.equal(resolveAnchoredStrokeYOffset(stroke, shiftedOffsets), 180);
  const shifted = resolveAnchoredStrokes([stroke], shiftedOffsets);
  assert.equal(shifted[0].anchorBlockIndex, 2);
  assert.equal(shifted[0].anchorBlockTop, 380);
  assert.deepEqual(
    shifted[0].points.map((p) => p.y),
    [425, 440],
  );

  // Legacy unanchored stroke remains untouched
  const legacy: InkStroke = {
    id: 'legacy-1',
    tool: 'ballpoint',
    color: '#0F172A',
    width: 3,
    points: [{ x: 0.3, y: 90 }],
  };
  const mixed = resolveAnchoredStrokes([legacy, stroke], shiftedOffsets);
  assert.equal(mixed[0], legacy);
  assert.equal(mixed[1].points[0].y, 425);
});
