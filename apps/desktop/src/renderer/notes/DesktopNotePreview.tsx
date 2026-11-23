import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeHandwritingPads, mergeHandwritingPads } from '../../shared/note-ink';
import {
  FloatingInkToolbox,
  HandwritingPadCard,
  InsertPadSlot,
  PadInsertBanner,
  scrollElementIntoPreview,
  useInkToolSession,
  type ActivePadControl,
} from '../../../../mobile/reader/HandwritingComponents';
import { buildBlockAnchor, extractBlockRefs, resolvePadAnchors } from '../../../../mobile/reader/ink-geometry';
import type { HandwritingPad, InkHeadingRef, PadBackground } from '../../../../mobile/reader/ink-types';
import type { CompiledNote } from './markdown';
import { NotePreview } from './NotePreview';

type PickMode = { kind: 'create' } | { kind: 'move'; padId: string } | null;

function makePadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pad-${crypto.randomUUID()}`;
  }
  return `pad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface DesktopNotePreviewProps {
  restoreScope?: string;
  source: string;
  path: string;
  vaultId: string;
  anchor?: string;
  initialOffset?: number;
  onOffset?: (offset: number) => void;
  onNavigate: (target: string, wiki: boolean, base?: string) => void;
  addPadNonce?: number;
  onPadCountChange?: (count: number) => void;
}

export function DesktopNotePreview({
  restoreScope,
  source,
  path,
  vaultId,
  anchor,
  initialOffset,
  onOffset,
  onNavigate,
  addPadNonce = 0,
  onPadCountChange,
}: DesktopNotePreviewProps) {
  const [compiled, setCompiled] = useState<CompiledNote | null>(null);
  const [pads, setPads] = useState<HandwritingPad[]>([]);
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBg, setDraftBg] = useState<PadBackground>('grid');
  const [autoFocusPadId, setAutoFocusPadId] = useState<string | null>(null);
  const [activePadId, setActivePadId] = useState<string | null>(null);
  const [activePadCtrl, setActivePadCtrl] = useState<{ id: string; ctrl: ActivePadControl } | null>(null);

  const inkSession = useInkToolSession(1);
  const padsRef = useRef(pads);
  padsRef.current = pads;

  const pendingSave = useRef<{ timer: number; vaultId: string; path: string; pads: HandwritingPad[] } | null>(null);
  const lastHandledAddNonce = useRef(addPadNonce);

  const flushSave = useCallback(async () => {
    const job = pendingSave.current;
    if (!job) return;
    window.clearTimeout(job.timer);
    pendingSave.current = null;
    await window.studyMate
      .noteInk({ action: 'save', vaultId: job.vaultId, path: job.path, pads: job.pads })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (addPadNonce !== lastHandledAddNonce.current) {
      lastHandledAddNonce.current = addPadNonce;
      setDraftTitle('');
      setActivePadId(null);
      setActivePadCtrl(null);
      setPickMode((cur) => (cur?.kind === 'create' ? null : { kind: 'create' }));
    }
  }, [addPadNonce]);

  useEffect(() => {
    setPickMode(null);
    setAutoFocusPadId(null);
    setActivePadId(null);
    setActivePadCtrl(null);
    if (!vaultId || !path || !window.studyMate?.noteInk) {
      setPads([]);
      return;
    }
    let live = true;
    const load = async (merge: boolean) => {
      try {
        const res = await window.studyMate.noteInk({ action: 'load', vaultId, path });
        if (!live) return;
        const incoming = Array.isArray(res?.pads) ? (res.pads as HandwritingPad[]) : [];
        if (merge) {
          setPads((prev) => mergeHandwritingPads(prev, incoming));
        } else {
          setPads(incoming);
        }
      } catch {
        if (!live || merge) return;
        setPads([]);
      }
    };
    void load(false);
    const unsubscribe = window.studyMate.onChanged?.(() => {
      void load(true);
    });
    return () => {
      live = false;
      unsubscribe?.();
      void flushSave();
    };
  }, [vaultId, path, flushSave]);

  const visiblePads = useMemo(() => activeHandwritingPads(pads), [pads]);
  useEffect(() => {
    onPadCountChange?.(visiblePads.length);
  }, [visiblePads.length, onPadCountChange]);

  const scheduleSave = useCallback(
    (nextPads: HandwritingPad[]) => {
      setPads(nextPads);
      if (!vaultId || !path || !window.studyMate?.noteInk) return;
      if (pendingSave.current) window.clearTimeout(pendingSave.current.timer);
      const timer = window.setTimeout(() => {
        pendingSave.current = null;
        void window.studyMate
          .noteInk({ action: 'save', vaultId, path, pads: nextPads })
          .then((res) => {
            if (Array.isArray(res?.pads)) {
              setPads((cur) => mergeHandwritingPads(cur, res.pads as HandwritingPad[]));
            }
          })
          .catch(() => {});
      }, 350);
      pendingSave.current = { timer, vaultId, path, pads: nextPads };
    },
    [vaultId, path],
  );

  const headings: InkHeadingRef[] = compiled?.headings ?? [];
  const blockRefs = useMemo(() => extractBlockRefs(compiled?.blocks), [compiled]);
  const resolved = useMemo(() => resolvePadAnchors(pads, headings, blockRefs), [pads, headings, blockRefs]);

  const updatePad = useCallback(
    (updated: HandwritingPad) => {
      const next = padsRef.current.map((p) => (p.id === updated.id ? updated : p));
      padsRef.current = next;
      scheduleSave(next);
    },
    [scheduleSave],
  );

  const handleActivatePad = useCallback((padId: string, ctrl: ActivePadControl) => {
    setActivePadId(padId);
    setActivePadCtrl({ id: padId, ctrl });
  }, []);

  const handleDeactivatePad = useCallback((padId: string) => {
    setActivePadId((cur) => (cur === padId ? null : cur));
    setAutoFocusPadId((cur) => (cur === padId ? null : cur));
    setActivePadCtrl((cur) => (cur?.id === padId ? null : cur));
  }, []);

  const deletePad = useCallback(
    (id: string) => {
      handleDeactivatePad(id);
      const now = Date.now();
      const next = padsRef.current.map((p) =>
        p.id === id ? { ...p, strokes: [], deletedAt: now, updatedAt: now } : p,
      );
      padsRef.current = next;
      scheduleSave(next);
    },
    [handleDeactivatePad, scheduleSave],
  );

  const applyAnchorChoice = useCallback(
    (target: { kind: 'top' } | { kind: 'bottom' } | { kind: 'block'; blockIndex: number }) => {
      const mode = pickMode;
      if (!mode) return;
      const now = Date.now();
      const anchorPatch =
        target.kind === 'top'
          ? {
              anchorType: 'top' as const,
              anchorHeadingId: '',
              anchorHeadingText: '',
              anchorBlockIndex: undefined,
              anchorBlockText: undefined,
              anchorBlockOffset: undefined,
            }
          : target.kind === 'bottom'
            ? {
                anchorType: 'bottom' as const,
                anchorHeadingId: '',
                anchorHeadingText: '',
                anchorBlockIndex: undefined,
                anchorBlockText: undefined,
                anchorBlockOffset: undefined,
              }
            : buildBlockAnchor(target.blockIndex, headings, blockRefs);

      if (mode.kind === 'move') {
        setPickMode(null);
        const moved = padsRef.current.map((p) =>
          p.id === mode.padId ? { ...p, ...anchorPatch, updatedAt: now } : p,
        );
        padsRef.current = moved;
        scheduleSave(moved);
        window.setTimeout(() => {
          scrollElementIntoPreview(document.getElementById(`pad-${mode.padId}`));
        }, 140);
        return;
      }

      const id = makePadId();
      const autoTitle =
        draftTitle.trim() ||
        (target.kind === 'top'
          ? '顶部手写栏'
          : target.kind === 'bottom'
            ? '文末手写栏'
            : anchorPatch.anchorBlockText
              ? `${anchorPatch.anchorBlockText.slice(0, 14)} · 手写`
              : `第 ${target.blockIndex + 1} 段 · 手写`);

      const created: HandwritingPad = {
        id,
        title: autoTitle,
        ...anchorPatch,
        logicalHeight: 460,
        background: draftBg,
        collapsed: false,
        strokes: [],
        createdAt: now,
        updatedAt: now,
      };
      if (inkSession.tool === 'browse' || inkSession.tool === 'eraser') {
        inkSession.selectTool(inkSession.activeBrush);
      }
      setPickMode(null);
      setDraftTitle('');
      setAutoFocusPadId(id);
      setActivePadId(id);
      const added = [...padsRef.current, created];
      padsRef.current = added;
      scheduleSave(added);
      window.setTimeout(() => {
        scrollElementIntoPreview(document.getElementById(`pad-${id}`));
      }, 160);
    },
    [pickMode, headings, blockRefs, draftTitle, draftBg, inkSession, scheduleSave],
  );

  const renderPad = (pad: HandwritingPad, orphaned = false) => (
    <HandwritingPadCard
      key={pad.id}
      pad={pad}
      headings={headings}
      orphaned={orphaned}
      autoFocus={autoFocusPadId === pad.id}
      allowMouse={true}
      active={activePadId === pad.id}
      session={inkSession}
      onActivate={handleActivatePad}
      onDeactivate={handleDeactivatePad}
      onChange={updatePad}
      onDelete={deletePad}
      onRequestMove={(id) => {
        setActivePadId(null);
        setActivePadCtrl(null);
        setPickMode({ kind: 'move', padId: id });
      }}
    />
  );

  const topAddon = (
    <>
      {pickMode && (
        <PadInsertBanner
          mode={pickMode.kind}
          title={draftTitle}
          background={draftBg}
          onTitleChange={setDraftTitle}
          onBackgroundChange={setDraftBg}
          onPickTop={() => applyAnchorChoice({ kind: 'top' })}
          onPickBottom={() => applyAnchorChoice({ kind: 'bottom' })}
          onCancel={() => setPickMode(null)}
        />
      )}
      {visiblePads.length > 0 && (
        <div className="pad-jump-bar">
          <span>已同步手写栏 ({visiblePads.length})</span>
          <div className="pad-jump-pills">
            {visiblePads.map((pad) => (
              <button
                key={pad.id}
                type="button"
                className="ink-btn"
                onClick={() =>
                  document.getElementById(`pad-${pad.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
              >
                {pad.title}
              </button>
            ))}
          </div>
        </div>
      )}
      {pickMode && (
        <InsertPadSlot
          mode={pickMode.kind}
          label="笔记顶部"
          onSelect={() => applyAnchorChoice({ kind: 'top' })}
        />
      )}
      {resolved.topPads.map((pad) => renderPad(pad, false))}
    </>
  );

  const bottomAddon = (
    <>
      {pickMode && (
        <InsertPadSlot
          mode={pickMode.kind}
          label="笔记末尾"
          onSelect={() => applyAnchorChoice({ kind: 'bottom' })}
        />
      )}
      {resolved.bottomPads.map((pad) => renderPad(pad, false))}
      {resolved.orphanedPads.map((pad) => renderPad(pad, true))}
    </>
  );

  const renderBlockAddon = (blockIndex: number) => {
    const list = resolved.blockPads.get(blockIndex);
    const hasPads = !!list && list.length > 0;
    if (!hasPads && !pickMode) return null;
    return (
      <>
        {pickMode && (
          <InsertPadSlot
            mode={pickMode.kind}
            onSelect={() => applyAnchorChoice({ kind: 'block', blockIndex })}
          />
        )}
        {hasPads && list!.map((pad) => renderPad(pad, false))}
      </>
    );
  };

  const activePadObj = activePadId ? visiblePads.find((p) => p.id === activePadId) : undefined;

  return (
    <>
      <NotePreview
        restoreScope={restoreScope}
        source={source}
        path={path}
        vaultId={vaultId}
        anchor={anchor}
        initialOffset={initialOffset}
        onOffset={onOffset}
        onNavigate={onNavigate}
        onCompiled={setCompiled}
        topAddon={topAddon}
        bottomAddon={bottomAddon}
        renderBlockAddon={renderBlockAddon}
      />

      <FloatingInkToolbox
        open={!!activePadCtrl && !!activePadObj && !activePadObj.collapsed}
        title={activePadObj?.title || '手写栏'}
        session={inkSession}
        allowMouse={true}
        canUndo={!!activePadCtrl?.ctrl.canUndo}
        canRedo={!!activePadCtrl?.ctrl.canRedo}
        hasStrokes={!!activePadCtrl?.ctrl.hasStrokes}
        onUndo={() => activePadCtrl?.ctrl.undo()}
        onRedo={() => activePadCtrl?.ctrl.redo()}
        onClear={() => activePadCtrl?.ctrl.clear()}
        onDone={() => activePadCtrl?.ctrl.finish()}
      />
    </>
  );
}
