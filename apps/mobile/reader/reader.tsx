import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompiledNote } from '../../desktop/src/renderer/notes/markdown';
import { NotePreview, type ReaderClient } from '../../desktop/src/renderer/notes/NotePreview';
import { activeHandwritingPads, mergeHandwritingPads } from '../../desktop/src/shared/note-ink';
import {
  FloatingInkToolbox,
  HandwritingPadCard,
  InsertPadSlot,
  PadInsertBanner,
  TempInkOverlay,
  scrollElementIntoPreview,
  useFingerScrollController,
  useInkToolSession,
  type ActivePadControl,
} from './HandwritingComponents';
import {
  buildBlockAnchor,
  extractBlockRefs,
  resolvePadAnchors,
  type BlockLayoutOffset,
} from './ink-geometry';
import type { HandwritingPad, InkHeadingRef, InkLoadResult, InkStroke, PadBackground } from './ink-types';
import './reader.css';

type ReaderTheme = 'paper' | 'warm' | 'mint';
type InkCommandName = 'toggleTempInk' | 'addPad' | 'clearTempInk';
type PickMode = { kind: 'create' } | { kind: 'move'; padId: string } | null;

type NativeMessage =
  | {
      type: 'render';
      source: string;
      path: string;
      vaultId: string;
      anchor?: string;
      conversation?: boolean;
      fontSize?: number;
      lineHeight?: number;
      readerTheme?: ReaderTheme;
      contentHash?: string;
      hideTools?: boolean;
    }
  | { type: 'scrollTop' }
  | { type: 'reloadInk' }
  | { type: 'inkCommand'; command: InkCommandName }
  | { type: 'reply'; id: number; value?: unknown; error?: string };

declare global {
  interface Window {
    StudyReader?: { postMessage(message: string): void };
    studyReaderReceive: (message: NativeMessage) => void;
  }
}

let serial = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

function native<T>(operation: string, input: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.StudyReader) return reject(Error('阅读连接尚未就绪。'));
    const id = ++serial;
    pending.set(id, { resolve, reject });
    window.StudyReader.postMessage(JSON.stringify({ id, operation, input }));
    setTimeout(() => {
      if (pending.delete(id)) reject(Error('资料读取超时，请重新连接。'));
    }, 30000);
  });
}

const client: ReaderClient = {
  noteImage: (_vaultId, base, target, wiki) => native('image', { base, target, wiki }),
  resolveNoteLink: (_vaultId, base, target, wiki) => native('resolve', { base, target, wiki }),
  readNote: (path) => native('read', { path }),
};

function makePadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pad-${crypto.randomUUID()}`;
  }
  return `pad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function Reader() {
  const [content, setContent] = useState({
    source: '正在准备阅读内容…',
    path: '',
    vaultId: '',
    anchor: '',
    conversation: false,
    fontSize: 16,
    lineHeight: 1.82,
    readerTheme: 'paper' as ReaderTheme,
    contentHash: '',
    hideTools: false,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const [compiled, setCompiled] = useState<CompiledNote | null>(null);
  const [pads, setPads] = useState<HandwritingPad[]>([]);
  const [tempStrokes, setTempStrokes] = useState<InkStroke[]>([]);
  const [tempInkActive, setTempInkActive] = useState(false);
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBg, setDraftBg] = useState<PadBackground>('grid');
  const [autoFocusPadId, setAutoFocusPadId] = useState<string | null>(null);
  const [activePadId, setActivePadId] = useState<string | null>(null);
  const [activePadCtrl, setActivePadCtrl] = useState<{ id: string; ctrl: ActivePadControl } | null>(null);
  const [toast, setToast] = useState('');
  const [inkReadyKey, setInkReadyKey] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  const inkSession = useInkToolSession(1);
  const padsRef = useRef(pads);
  padsRef.current = pads;

  const pendingPadSave = useRef<{ timer: number; scopeId: string; path: string; pads: HandwritingPad[] } | null>(null);
  const pendingTempSave = useRef<{
    timer: number;
    scopeId: string;
    path: string;
    contentHash: string;
    strokes: InkStroke[];
  } | null>(null);

  const flushPendingSaves = useCallback(
    async (nextScope?: string, nextPath?: string, nextHash?: string): Promise<void> => {
      const tasks: Promise<unknown>[] = [];
      const padJob = pendingPadSave.current;
      if (padJob) {
        window.clearTimeout(padJob.timer);
        pendingPadSave.current = null;
        tasks.push(
          native('ink_save_pads', { scopeId: padJob.scopeId, path: padJob.path, pads: padJob.pads }).catch(() => {}),
        );
      }
      const tmpJob = pendingTempSave.current;
      if (tmpJob) {
        window.clearTimeout(tmpJob.timer);
        pendingTempSave.current = null;
        const staleForSameNote =
          nextScope !== undefined &&
          tmpJob.scopeId === nextScope &&
          tmpJob.path === nextPath &&
          tmpJob.contentHash !== nextHash;
        if (!staleForSameNote) {
          tasks.push(
            native('ink_save_temp', {
              scopeId: tmpJob.scopeId,
              path: tmpJob.path,
              contentHash: tmpJob.contentHash,
              strokes: tmpJob.strokes,
            }).catch(() => {}),
          );
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
    },
    [],
  );

  useFingerScrollController(rootRef, !content.conversation);

  useEffect(() => {
    window.StudyReader?.postMessage(JSON.stringify({ id: 0, operation: 'ready', input: {} }));
    return () => {
      void flushPendingSaves();
    };
  }, [flushPendingSaves]);

  useEffect(() => {
    const theme = content.conversation ? 'paper' : content.readerTheme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--reader-font-size', `${content.fontSize}px`);
    document.documentElement.style.setProperty('--reader-line-height', String(content.lineHeight));
  }, [content.conversation, content.fontSize, content.lineHeight, content.readerTheme]);

  const noteIdentity = `${content.vaultId}\n${content.path}`;
  const inkScopeKey = !content.conversation && content.path ? `${noteIdentity}\n${content.contentHash}` : '';
  const prevNoteIdentity = useRef('');

  useEffect(() => {
    if (prevNoteIdentity.current !== noteIdentity) {
      prevNoteIdentity.current = noteIdentity;
      setPads([]);
      padsRef.current = [];
      setTempStrokes([]);
      setTempInkActive(false);
      setPickMode(null);
      setAutoFocusPadId(null);
      setActivePadId(null);
      setActivePadCtrl(null);
      setToast('');
    }
  }, [noteIdentity]);

  useEffect(() => {
    if (!inkScopeKey) {
      void flushPendingSaves();
      setPads([]);
      padsRef.current = [];
      setTempStrokes([]);
      setInkReadyKey('');
      return;
    }
    let live = true;
    const reqScope = content.vaultId;
    const reqPath = content.path;
    const reqHash = content.contentHash;
    const isSyncReload = reloadNonce > 0 && inkReadyKey === inkScopeKey;
    void (async () => {
      await flushPendingSaves(reqScope, reqPath, reqHash);
      if (!live) return;
      try {
        const res = await native<InkLoadResult>('ink_load', {
          scopeId: reqScope,
          path: reqPath,
          contentHash: reqHash,
        });
        if (!live) return;
        const incomingPads = Array.isArray(res?.pads) ? res.pads : [];
        const incomingTemp = Array.isArray(res?.tempStrokes) ? res.tempStrokes : [];
        setPads((prev) => {
          const merged = mergeHandwritingPads(prev, incomingPads);
          padsRef.current = merged;
          return merged;
        });
        if (!isSyncReload) {
          setTempStrokes((prev) => (prev.length > 0 ? prev : incomingTemp));
        }
        setInkReadyKey(inkScopeKey);
        if (!isSyncReload && res?.tempClearedByChange) {
          setToast('检测到笔记内容已修改，临时手写墨迹已自动清除（手写栏墨迹已保留）');
        }
      } catch {
        if (!live || isSyncReload) return;
        setInkReadyKey(inkScopeKey);
      }
    })();
    return () => {
      live = false;
    };
  }, [inkScopeKey, content.vaultId, content.path, content.contentHash, reloadNonce, flushPendingSaves]);

  const scheduleSavePads = useCallback(
    (nextPads: HandwritingPad[]) => {
      setPads(nextPads);
      if (inkReadyKey !== inkScopeKey || !content.path) return;
      if (pendingPadSave.current) window.clearTimeout(pendingPadSave.current.timer);
      const scopeId = content.vaultId;
      const path = content.path;
      const timer = window.setTimeout(() => {
        pendingPadSave.current = null;
        void native<{ ok?: boolean; pads?: HandwritingPad[] }>('ink_save_pads', {
          scopeId,
          path,
          pads: nextPads,
        })
          .then((res) => {
            if (Array.isArray(res?.pads) && res.pads.length > 0) {
              setPads((cur) => mergeHandwritingPads(cur, res.pads!));
            }
          })
          .catch(() => {});
      }, 450);
      pendingPadSave.current = { timer, scopeId, path, pads: nextPads };
    },
    [inkReadyKey, inkScopeKey, content.vaultId, content.path],
  );

  const scheduleSaveTemp = useCallback(
    (nextStrokes: InkStroke[]) => {
      setTempStrokes(nextStrokes);
      if (inkReadyKey !== inkScopeKey || !content.path) return;
      if (pendingTempSave.current) window.clearTimeout(pendingTempSave.current.timer);
      const scopeId = content.vaultId;
      const path = content.path;
      const contentHash = content.contentHash;
      const timer = window.setTimeout(() => {
        pendingTempSave.current = null;
        void native('ink_save_temp', { scopeId, path, contentHash, strokes: nextStrokes }).catch(() => {});
      }, 450);
      pendingTempSave.current = { timer, scopeId, path, contentHash, strokes: nextStrokes };
    },
    [inkReadyKey, inkScopeKey, content.vaultId, content.path, content.contentHash],
  );

  const handleInkCommand = useCallback(
    (command: InkCommandName) => {
      if (content.conversation || !content.path) return;
      if (command === 'toggleTempInk') {
        setPickMode(null);
        setActivePadId(null);
        setActivePadCtrl(null);
        setTempInkActive((v) => !v);
      } else if (command === 'addPad') {
        setTempInkActive(false);
        setActivePadId(null);
        setActivePadCtrl(null);
        setDraftTitle('');
        setPickMode((cur) => (cur?.kind === 'create' ? null : { kind: 'create' }));
      } else if (command === 'clearTempInk') {
        if (pendingTempSave.current) {
          window.clearTimeout(pendingTempSave.current.timer);
          pendingTempSave.current = null;
        }
        setTempStrokes([]);
        void native('ink_clear_temp', { scopeId: content.vaultId, path: content.path }).catch(() => {});
      }
    },
    [content.conversation, content.path, content.vaultId],
  );

  const latestCommandHandler = useRef(handleInkCommand);
  latestCommandHandler.current = handleInkCommand;

  window.studyReaderReceive = (message) => {
    if (message.type === 'render') {
      setContent((prev) => ({
        ...prev,
        ...message,
        anchor: message.anchor || '',
        conversation: !!message.conversation,
        fontSize: typeof message.fontSize === 'number' ? message.fontSize : prev.fontSize,
        lineHeight: typeof message.lineHeight === 'number' ? message.lineHeight : prev.lineHeight,
        readerTheme: message.readerTheme || prev.readerTheme,
        contentHash: typeof message.contentHash === 'string' ? message.contentHash : prev.contentHash,
        hideTools: typeof message.hideTools === 'boolean' ? message.hideTools : prev.hideTools,
      }));
    } else if (message.type === 'scrollTop') {
      const scroller = rootRef.current?.querySelector('.note-preview-scroll');
      if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (message.type === 'reloadInk') {
      setReloadNonce((n) => n + 1);
    } else if (message.type === 'inkCommand') {
      latestCommandHandler.current(message.command);
    } else {
      const job = pending.get(message.id);
      pending.delete(message.id);
      if (job) message.error ? job.reject(Error(message.error)) : job.resolve(message.value);
    }
  };

  const headings: InkHeadingRef[] = compiled?.headings ?? [];
  const blockRefs = useMemo(() => extractBlockRefs(compiled?.blocks), [compiled]);
  const visiblePads = useMemo(() => activeHandwritingPads(pads), [pads]);
  const resolved = useMemo(() => resolvePadAnchors(pads, headings, blockRefs), [pads, headings, blockRefs]);

  const updatePad = useCallback(
    (updated: HandwritingPad) => {
      const next = padsRef.current.map((p) => (p.id === updated.id ? updated : p));
      padsRef.current = next;
      scheduleSavePads(next);
    },
    [scheduleSavePads],
  );

  const handleActivatePad = useCallback((padId: string, ctrl: ActivePadControl) => {
    setTempInkActive(false);
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
      scheduleSavePads(next);
    },
    [handleDeactivatePad, scheduleSavePads],
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
        scheduleSavePads(moved);
        window.setTimeout(() => {
          scrollElementIntoPreview(document.getElementById(`pad-${mode.padId}`));
        }, 140);
        return;
      }

      const id = makePadId();
      const defaultHeight = typeof window !== 'undefined' && window.innerWidth >= 600 ? 380 : 360;
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
        logicalHeight: defaultHeight,
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
      scheduleSavePads(added);
      window.setTimeout(() => {
        scrollElementIntoPreview(document.getElementById(`pad-${id}`));
      }, 160);
    },
    [pickMode, headings, blockRefs, draftTitle, draftBg, inkSession, scheduleSavePads],
  );

  const renderPad = (pad: HandwritingPad, orphaned = false) => (
    <HandwritingPadCard
      key={pad.id}
      pad={pad}
      headings={headings}
      orphaned={orphaned}
      autoFocus={autoFocusPadId === pad.id}
      allowMouse={false}
      active={activePadId === pad.id}
      session={inkSession}
      onActivate={handleActivatePad}
      onDeactivate={handleDeactivatePad}
      onChange={updatePad}
      onDelete={deletePad}
      onRequestMove={(id) => {
        setTempInkActive(false);
        setActivePadId(null);
        setActivePadCtrl(null);
        setPickMode({ kind: 'move', padId: id });
      }}
    />
  );

  const topAddon = !content.conversation ? (
    <>
      {toast && (
        <div className="ink-toast" role="status">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast('')}>
            知道了
          </button>
        </div>
      )}
      {visiblePads.length > 0 && (
        <div className="pad-jump-bar">
          <span>手写栏 ({visiblePads.length})</span>
          <div className="pad-jump-pills">
            {visiblePads.map((pad) => (
              <button
                key={pad.id}
                type="button"
                className="ink-btn"
                onClick={() => scrollElementIntoPreview(document.getElementById(`pad-${pad.id}`))}
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
  ) : undefined;

  const bottomAddon = !content.conversation ? (
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
  ) : undefined;

  const renderBlockAddon = !content.conversation
    ? (blockIndex: number) => {
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
      }
    : undefined;

  const contentOverlay = !content.conversation
    ? ({
        totalHeight,
        blockOffsets,
      }: {
        totalHeight: number;
        blockOffsets?: readonly BlockLayoutOffset[];
      }) => (
        <TempInkOverlay
          active={tempInkActive}
          totalHeight={totalHeight}
          blockOffsets={blockOffsets}
          strokes={tempStrokes}
          session={inkSession}
          allowMouse={false}
          onChange={scheduleSaveTemp}
          onClose={() => setTempInkActive(false)}
        />
      )
    : undefined;

  const activePadObj = activePadId ? visiblePads.find((p) => p.id === activePadId) : undefined;

  return (
    <div
      ref={rootRef}
      className={content.conversation ? 'reader-shell note-conversation' : 'reader-shell'}
      data-theme={content.conversation ? 'paper' : content.readerTheme}
    >
      {pickMode && !content.conversation && (
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
      <NotePreview
        key={content.path}
        source={content.source}
        path={content.path}
        vaultId={content.vaultId}
        anchor={content.anchor}
        followOutput={content.conversation}
        hideTools={content.conversation || content.hideTools}
        client={client}
        onCompiled={setCompiled}
        topAddon={topAddon}
        bottomAddon={bottomAddon}
        renderBlockAddon={renderBlockAddon}
        contentOverlay={contentOverlay}
        onNavigate={(target, wiki, base) =>
          void native('navigate', { target, wiki, base: base || content.path })
        }
      />

      {!content.conversation && !tempInkActive && (
        <FloatingInkToolbox
          open={!!activePadCtrl && !!activePadObj && !activePadObj.collapsed}
          title={activePadObj?.title || '手写栏'}
          session={inkSession}
          allowMouse={false}
          canUndo={!!activePadCtrl?.ctrl.canUndo}
          canRedo={!!activePadCtrl?.ctrl.canRedo}
          hasStrokes={!!activePadCtrl?.ctrl.hasStrokes}
          onUndo={() => activePadCtrl?.ctrl.undo()}
          onRedo={() => activePadCtrl?.ctrl.redo()}
          onClear={() => activePadCtrl?.ctrl.clear()}
          onDone={() => activePadCtrl?.ctrl.finish()}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Reader />);
