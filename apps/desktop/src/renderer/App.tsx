import { LearningPanel } from './learning/LearningPanel';
import { parseVideoCitation, type OcrResult } from '../shared/recognition';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NotePane } from './workspace/NotePane';
import { useNoteDesk } from './workspace/useNoteDesk';
import { ResizeHandle } from './workspace/ResizeHandle';
import { isDirty, type Pane } from './workspace/note-desk';
import type { CSSProperties } from 'react';
import { AiPanel } from './ai/AiPanel';
import { DocumentPane } from './documents/DocumentPane';
import { parseDocumentCitation, type DocumentContext } from '../shared/documents';
import { VideoControls } from './workspace/VideoControls';
import { Tree, type NodeRendererProps } from 'react-arborist';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Video,
  X,
  Zap,
} from 'lucide-react';
import type { AppState, NoteFile, SearchHit, TaskStatus } from '../shared/contracts';

const api = window.studyMate;
const time = (seconds: number) =>
  Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0') +
  ':' +
  Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
const taskLabels: Record<TaskStatus, string> = {
  queued: '等待中',
  running: '处理中',
  succeeded: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '已中断',
};
const textOf = (error: unknown) => (error instanceof Error ? error.message : '操作未完成，请重试。');
type Mode = 'home' | 'browser' | 'note' | 'analysis' | 'document';

function readLayout(): { left: number; right: number; height: number } {
  try {
    const p = JSON.parse(localStorage.getItem('study-layout-v1') || '{}');
    return {
      left: Math.min(480, Math.max(180, Number(p.left) || 246)),
      right: Math.min(800, Math.max(280, Number(p.right) || 328)),
      height: Math.min(800, Math.max(180, Number(p.height) || window.innerHeight * 0.62)),
    };
  } catch {
    return { left: 246, right: 328, height: window.innerHeight * 0.62 };
  }
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [mode, setMode] = useState<Mode>('home');
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [address, setAddress] = useState('');
  const [loadingWeb, setLoadingWeb] = useState(false);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [learningOpen, setLearningOpen] = useState(false);
  const [aiDraft, setAiDraft] = useState<{
    id: string;
    text: string;
    image?: { vaultId: string; path: string };
  }>();
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiHasMessages, setAiHasMessages] = useState(false);
  const desk = useNoteDesk(state?.vaultId, setError);
  const document = desk.active('main')?.document || null;
  const dirty = desk.dirty,
    loadingNote = desk.loading;
  const [switchingVault, setSwitchingVault] = useState(false);
  const navigation = useRef<(target: string, wiki: boolean, base: string, pane: Pane) => void>(() => {});
  const navigate = useCallback(
    (target: string, wiki: boolean, base: string, pane: Pane) =>
      navigation.current(target, wiki, base, pane),
    [],
  );
  const [leftWidth, setLeftWidth] = useState(() => readLayout().left);
  const [rightWidth, setRightWidth] = useState(() => readLayout().right);
  const [studyHeight, setStudyHeight] = useState(() => readLayout().height);
  const [videoLocation, setVideoLocation] = useState<Pane>('main');
  const [dockActive, setDockActive] = useState<'note' | 'video' | 'document'>('note');
  const [docTabs, setDocTabs] = useState<Record<Pane, string[]>>({ main: [], side: [] });
  const [docActive, setDocActive] = useState<Record<Pane, string | null>>({ main: null, side: null });
  const [docPage, setDocPage] = useState<Record<string, number>>({});
  const [docContext, setDocContext] = useState<DocumentContext>();

  const activateDocument = (id: string, page?: number, pane: Pane = 'main') => {
    setDocTabs((prev) => ({
      ...prev,
      [pane]: prev[pane].includes(id) ? prev[pane] : [...prev[pane], id],
    }));
    setDocActive((prev) => ({ ...prev, [pane]: id }));
    if (page) setDocPage((prev) => ({ ...prev, [id]: page }));
    if (pane === 'main') setMode('document');
    else setDockActive('document');
  };

  const openVideoEvidence = async (id: string, targetTime: number) => {
    try {
      if (state?.activeBinding?.sourceId !== id) await api.openSource(id);
      setVideoLocation('main');
      setMode('browser');
      await api.player({ action: 'seek', time: targetTime });
    } catch (e) {
      setError(textOf(e));
    }
  };

  const askOriginalImage = (source: OcrResult['source']) => {
    if (source.kind === 'image' && source.vaultId && source.vaultId !== state?.vaultId) {
      setError('知识库已切换，请重新选择原图');
      return;
    }
    let text = '请以原图为准分析内容，复杂公式和模糊区域说明不确定性，不要仅凭 OCR 参考文字下结论。';
    if (source.kind === 'document') {
      activateDocument(source.id, source.page || 1);
      text +=
        '请调用 view_document_page 查看文档 ' +
        source.id +
        ' 第' +
        (source.page || 1) +
        '页' +
        (source.region ? '，选区 ' + JSON.stringify(source.region) : '') +
        '。';
    } else if (source.kind === 'video') {
      void openVideoEvidence(source.id, source.time || 0);
      text +=
        '请调用 analyze_video 查看原视频 ' +
        source.id +
        ' 在 ' +
        (source.time || 0).toFixed(2) +
        ' 秒附近的真实画面。';
    } else {
      text += '请调用 view_image 读取知识库图片路径：' + JSON.stringify(source.id) + '。';
    }
    setAiDraft({
      id: crypto.randomUUID(),
      text,
      image:
        source.kind === 'image' && !source.id.startsWith('frame:')
          ? { vaultId: source.vaultId || state?.vaultId || '', path: source.id }
          : undefined,
    });
    setLearningOpen(false);
  };

  const openDocument = async () => {
    try {
      const doc = await api.chooseDocument();
      if (doc) activateDocument(doc.id, doc.lastPage);
    } catch (e) {
      setError(textOf(e));
    }
  };

  const closeDocument = (id: string, pane: Pane) => {
    const remaining = docTabs[pane].filter((x) => x !== id);
    setDocTabs((prev) => ({ ...prev, [pane]: remaining }));
    if (docActive[pane] === id) {
      setDocActive((prev) => ({ ...prev, [pane]: remaining.at(-1) || null }));
      if (!remaining.length) {
        if (pane === 'main') setMode(document ? 'note' : 'home');
        else setDockActive(desk.desk.side.active ? 'note' : 'video');
      }
    }
    if (docContext?.id === id) setDocContext(undefined);
  };

  const moveDocument = (id: string, from: Pane, to: Pane) => {
    if (from === to) {
      activateDocument(id, undefined, to);
      return;
    }
    closeDocument(id, from);
    activateDocument(id, undefined, to);
    if (to === 'side') {
      setRightWidth(Math.max(420, Math.round((window.innerWidth - leftWidth) * 0.45)));
      setMode(state?.activeBinding && videoLocation === 'main' ? 'browser' : document ? 'note' : 'home');
    }
  };

  const documentTabs = (pane: Pane) =>
    docTabs[pane].map((id) => (
      <button
        key={id}
        className={
          (pane === 'main' ? mode === 'document' : dockActive === 'document') && docActive[pane] === id
            ? 'tab current'
            : 'tab'
        }
        title={state?.documents?.find((d) => d.id === id)?.title}
        onPointerDown={(e) => dragTab(e, 'document', id, pane)}
        onClick={() => {
          if (!consumeTabClick.current) activateDocument(id, undefined, pane);
        }}
      >
        <FileText size={14} />
        <span>{state?.documents?.find((d) => d.id === id)?.title || '文档'}</span>
        <span
          role="button"
          tabIndex={0}
          aria-label="关闭文档"
          onClick={(e) => {
            e.stopPropagation();
            closeDocument(id, pane);
          }}
        >
          <X size={12} />
        </span>
      </button>
    ));

  const [dragging, setDragging] = useState(false),
    [resizing, setResizing] = useState(false);
  const tabGesture = useRef<{
    kind: 'note' | 'video' | 'document';
    path: string;
    from: Pane;
    x: number;
    y: number;
    moving: boolean;
    pointer: number;
    element: HTMLElement;
  } | null>(null);
  const consumeTabClick = useRef(false);
  const gestureDrop = useRef<
    (kind: 'note' | 'video' | 'document', path: string, from: Pane, to: Pane) => void
  >(() => {});
  const endGesture = useCallback(() => {
    const drag = tabGesture.current;
    tabGesture.current = null;
    if (drag?.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
    setDragging(false);
    setTimeout(() => {
      consumeTabClick.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = tabGesture.current;
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!drag.moving && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) {
        drag.moving = true;
        consumeTabClick.current = true;
        setDragging(true);
      }
      if (drag.moving) event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      const drag = tabGesture.current;
      if (!drag || event.pointerId !== drag.pointer) return;
      try {
        if (drag.moving) {
          const target = window.document.elementFromPoint(event.clientX, event.clientY);
          const to = target?.closest('.companion') ? 'side' : target?.closest('main.reader') ? 'main' : null;
          if (to) gestureDrop.current(drag.kind, drag.path, drag.from, to);
        }
      } finally {
        endGesture();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        endGesture();
        setDragging(false);
      }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', endGesture);
    window.addEventListener('lostpointercapture', endGesture);
    window.addEventListener('blur', endGesture);
    window.addEventListener('keydown', escape);
    window.addEventListener('dragend', endGesture);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', endGesture);
      window.removeEventListener('lostpointercapture', endGesture);
      window.removeEventListener('blur', endGesture);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('dragend', endGesture);
    };
  }, [endGesture]);

  const dockOpen =
    dockActive === 'video'
      ? videoLocation === 'side' && Boolean(state?.activeBinding)
      : dockActive === 'document'
        ? Boolean(docActive.side)
        : Boolean(desk.desk.side.active);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  useEffect(() => {
    if (
      dockActive !== 'document' &&
      !desk.desk.side.active &&
      videoLocation === 'side' &&
      state?.activeBinding
    )
      setDockActive('video');
  }, [desk.desk.side.active, videoLocation, state?.activeBinding]);

  useEffect(() => {
    if (mode === 'note' && !document && !loadingNote) setMode('home');
  }, [mode, document, loadingNote]);

  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const timer = setTimeout(
      () =>
        localStorage.setItem(
          'study-layout-v1',
          JSON.stringify({ left: leftWidth, right: rightWidth, height: studyHeight }),
        ),
      150,
    );
    return () => clearTimeout(timer);
  }, [leftWidth, rightWidth, studyHeight]);

  const dragTab = (
    event: React.PointerEvent<HTMLElement>,
    kind: 'note' | 'video' | 'document',
    path = '',
    from: Pane = 'main',
  ) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[role="button"]')) return;
    consumeTabClick.current = false;
    tabGesture.current = {
      kind,
      path,
      from,
      x: event.clientX,
      y: event.clientY,
      moving: false,
      pointer: event.pointerId,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const dockNote = (path: string, from: Pane) => {
    const to: Pane = from === 'main' ? 'side' : 'main';
    desk.move(path, from, to);
    if (to === 'side') {
      setDockActive('note');
      setVideoLocation('main');
      setRightWidth(Math.max(400, Math.round((window.innerWidth - leftWidth) * 0.45)));
      if (state?.activeBinding) setMode('browser');
    } else {
      setMode('note');
    }
  };

  const dockVideo = () => {
    setVideoLocation('side');
    setDockActive('video');
    setRightWidth(Math.max(400, Math.round((window.innerWidth - leftWidth) * 0.45)));
    setMode(document ? 'note' : 'home');
  };

  gestureDrop.current = (kind, path, from, to) => {
    if (kind === 'document') {
      moveDocument(path, from, to);
      return;
    }
    if (kind === 'note' && Object.hasOwn(desk.desk.sessions, path)) {
      if (from !== to) dockNote(path, from);
      else void desk.open(path, '', to);
    } else if (kind === 'video' && state?.activeBinding) {
      if (to === 'side') dockVideo();
      else {
        setVideoLocation('main');
        setMode('browser');
      }
    }
  };

  const dropTab = (event: React.DragEvent, to: Pane) => {
    event.preventDefault();
    setDragging(false);
    try {
      const item = JSON.parse(event.dataTransfer.getData('application/x-study-tab'));
      if (item.kind === 'document') moveDocument(item.path, item.from, to);
      if (item.kind === 'note' && desk.desk.sessions[item.path]) {
        if (item.from !== to) dockNote(item.path, item.from);
        else void desk.open(item.path, '', to);
      }
      if (item.kind === 'video') {
        if (to === 'side') dockVideo();
        else {
          setVideoLocation('main');
          setMode('browser');
        }
      }
    } catch {}
  };

  const [rangeStart, setRangeStart] = useState('0');
  const [rangeEnd, setRangeEnd] = useState('');
  const [frameCount, setFrameCount] = useState('6');
  const browserBox = useRef<HTMLDivElement>(null);
  const searchGeneration = useRef(0);
  const stateGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++stateGeneration.current;
    try {
      const next = await api.state();
      if (generation === stateGeneration.current) setState(next);
    } catch (cause) {
      setError(textOf(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.onChanged(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    void api
      .setDirty({
        dirty,
        paths: Object.entries(desk.desk.sessions)
          .filter(([, s]) => isDirty(s))
          .map(([p]) => p),
      })
      .catch(() => {});
  }, [dirty, desk.desk.sessions]);

  useEffect(() => {
    if (state?.activeBinding?.url) setAddress(state.activeBinding.url);
  }, [state?.activeBinding?.url]);

  useEffect(() => {
    let live = true;
    void api.listNotes().then(
      (value) => {
        if (live) setNotes(value);
      },
      (cause) => setError(textOf(cause)),
    );
    return () => {
      live = false;
    };
  }, [state?.vaultId, state?.vaultRevision]);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!search.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void api.searchNotes(search).then(
        (value) => {
          if (generation === searchGeneration.current) setHits(value);
        },
        (cause) => setError(textOf(cause)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [search, state?.vaultRevision, state?.knowledge?.files, state?.knowledge?.embedding]);

  useLayoutEffect(() => {
    const update = () => {
      const rect = browserBox.current?.getBoundingClientRect();
      void api
        .setBrowserBounds({
          x: rect?.x || 0,
          y: rect?.y || 0,
          width: rect?.width || 0,
          height: rect?.height || 0,
          visible:
            ((videoLocation === 'main' && mode === 'browser') ||
              (videoLocation === 'side' && dockOpen && dockActive === 'video')) &&
            !helpOpen &&
            !learningOpen &&
            !aiSettingsOpen &&
            !dragging &&
            !resizing &&
            !desk.closing &&
            !window.document.querySelector('.diagram-modal,.modal-overlay'),
        })
        .catch(() => {});
    };
    update();
    const observer = new ResizeObserver(update);
    const modals = new MutationObserver(update);
    modals.observe(window.document.body, { childList: true });
    if (browserBox.current) observer.observe(browserBox.current);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      modals.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [
    mode,
    collapsed,
    helpOpen,
    learningOpen,
    aiSettingsOpen,
    videoLocation,
    dockActive,
    dockOpen,
    dragging,
    resizing,
    desk.closing,
    state?.activeBinding?.visitId,
    state?.vaultId,
  ]);

  useEffect(() => {
    const beforeClose = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeClose);
    return () => window.removeEventListener('beforeunload', beforeClose);
  }, [dirty]);

  const persist = () => desk.saveAll();
  const openNote = async (path: string, anchor = '') => {
    if (await desk.open(path, anchor, 'main')) setMode('note');
  };
  const createNote = async () => {
    if (await desk.create()) setMode('note');
  };
  const chooseVault = async () => {
    if (switchingVault || !(await persist())) return;
    setSwitchingVault(true);
    try {
      const next = await api.chooseVault();
      if (next.vaultId !== state?.vaultId) {
        setMode('home');
        setDockActive('note');
        setVideoLocation('main');
      }
      setState(next);
      setError('');
    } catch (cause) {
      setError(textOf(cause));
    } finally {
      setSwitchingVault(false);
    }
  };
  const openWeb = async (target = address) => {
    setLoadingWeb(true);
    setError('');
    setMode('browser');
    setVideoLocation('main');
    const url = target.trim() || 'https://www.bilibili.com/';
    setAddress(url);
    try {
      setState(await api.openWeb(url));
    } catch (cause) {
      setError(textOf(cause));
    } finally {
      setLoadingWeb(false);
    }
  };
  const importNotes = async () => {
    if (!(await persist())) return;
    try {
      const report = await api.importNotes();
      if (report.paths[0]) await openNote(report.paths[0]);
      if (report.errors.length) setError(report.errors.join('；'));
      await refresh();
    } catch (cause) {
      setError(textOf(cause));
    }
  };
  const openLocal = async () => {
    try {
      const next = await api.openLocal();
      setState(next);
      if (next.activeBinding) {
        setMode('browser');
        setVideoLocation('main');
      }
      setError('');
    } catch (cause) {
      setError(textOf(cause));
    }
  };
  const openFolder = (relative?: string) =>
    void api.openFolder(relative).catch((cause) => setError(textOf(cause)));

  navigation.current = (target, wiki, base, pane) => {
    const video = parseVideoCitation(target);
    if (video) {
      void openVideoEvidence(video.id, video.time);
      return;
    }
    const citation = parseDocumentCitation(target);
    if (citation) {
      activateDocument(citation.id, citation.page, pane);
      return;
    }
    if (/^https?:\/\//i.test(target)) {
      void openWeb(target);
      return;
    }
    if (!state) return;
    const vaultId = state.vaultId;
    void api.resolveNoteLink(vaultId, base, target, wiki).then(
      async (link) => {
        if (await desk.open(link.path, link.anchor, pane)) {
          if (pane === 'main') setMode('note');
          else setDockActive('note');
        }
      },
      (cause) => setError(textOf(cause)),
    );
  };

  const analyze = async () => {
    setError('');
    try {
      await api.analyze({
        start: Number(rangeStart),
        end: rangeEnd.trim() ? Number(rangeEnd) : null,
        count: Number(frameCount),
      });
    } catch (cause) {
      setError(textOf(cause));
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (helpOpen || learningOpen || aiSettingsOpen || desk.closing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const path = desk.desk[desk.desk.focused].active;
        if (path) void desk.save(path);
      }
      if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const pane = desk.desk.focused;
        void desk.history(pane, event.key === 'ArrowLeft' ? -1 : 1).then((ok) => {
          if (ok) {
            if (pane === 'main') setMode('note');
            else setDockActive('note');
          }
        });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
        const pane = desk.desk.focused,
          path = desk.desk[pane].active;
        if (path) {
          event.preventDefault();
          desk.close(pane, path);
        }
      }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        const pane = desk.desk.focused,
          p = desk.desk[pane],
          n = p.tabs.length;
        if (n) {
          const at = p.tabs.indexOf(p.active || '');
          void desk.open(p.tabs[(at + (event.shiftKey ? -1 : 1) + n) % n], '', pane);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const source = state?.sources.find((s) => s.id === state.activeBinding?.sourceId);
  const playback = state?.playback;
  const running = state?.tasks.some((t) => t.status === 'running' || t.status === 'queued') || false;
  const noteCount = (nodes: NoteFile[]): number =>
    nodes.reduce((count, node) => count + (node.children ? noteCount(node.children) : 1), 0);

  function FileNode({ node, style }: NodeRendererProps<NoteFile>) {
    return (
      <div
        style={style}
        className={'file-node ' + (document?.path === node.data.path ? 'selected' : '')}
        onClick={() => {
          if (node.isInternal) node.toggle();
          else void openNote(node.data.path);
        }}
      >
        {node.isInternal ? (
          <>
            <ChevronRight size={13} className={node.isOpen ? 'rotated' : ''} />
            <Folder size={14} className="folder-icon" />
          </>
        ) : (
          <>
            <span className="tree-spacer" />
            <FileText size={14} className="note-icon" />
          </>
        )}
        <span>{node.data.name.replace(/\.md$/i, '')}</span>
        {document?.path === node.data.path && dirty && <i className="dirty-dot" />}
      </div>
    );
  }

  return (
    <div
      onClickCapture={(event) => {
        if (consumeTabClick.current) {
          event.preventDefault();
          event.stopPropagation();
          consumeTabClick.current = false;
        }
      }}
      className={
        'app ' +
        (collapsed ? 'sidebar-collapsed ' : '') +
        (resizing ? 'resizing ' : '') +
        (dockOpen ? 'has-study-dock' : '')
      }
      style={
        {
          '--sidebar': collapsed ? '0px' : leftWidth + 'px',
          '--companion': Math.min(rightWidth, windowWidth - (collapsed ? 0 : leftWidth) - 330) + 'px',
        } as CSSProperties
      }
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Leaf size={20} strokeWidth={2} />
          </span>
          <div>
            <strong>Study Mate</strong>
            <span>让理解，慢慢生长</span>
          </div>
        </div>
        <div className="space-label">
          <span>个人学习空间</span>
          <ChevronDown size={13} />
        </div>
        <nav>
          <button
            className={mode === 'home' ? 'nav-item active' : 'nav-item'}
            onClick={() => setMode('home')}
          >
            <LayoutDashboard size={16} />
            学习工作台
          </button>
          <button
            className={mode === 'browser' ? 'nav-item active' : 'nav-item'}
            onClick={() => setMode('browser')}
          >
            <Globe2 size={16} />
            课程浏览器{source && <span className="nav-dot" />}
          </button>
          <div className="document-library">
            <button onClick={() => void openDocument()}>
              <FileText size={15} /> 打开 PDF / PowerPoint
            </button>
            {state?.documents?.slice(0, 12).map((d) => (
              <button key={d.id} title={d.title} onClick={() => activateDocument(d.id, d.lastPage)}>
                {d.kind.toUpperCase()} · {d.title}
              </button>
            ))}
          </div>
        </nav>
        <div className="document-library">
          <button className="recognition-launch" onClick={() => setLearningOpen(true)}>
            <Sparkles size={15} /> 识别与全库检索
          </button>
          <div className="knowledge-sidebar-status">
            索引 {state?.knowledge?.files.toLocaleString() || 0} 篇 ·{' '}
            {state?.knowledge?.phase === 'scanning' ? '后台扫描中' : '全文可检索'}
            {state?.knowledge?.skipped ? ` · 跳过 ${state.knowledge.skipped} 篇` : null}
          </div>
        </div>
        <div className="library-actions">
          <button onClick={() => void importNotes()}>
            <ArrowDownToLine size={14} />
            导入 Markdown
          </button>
          <button aria-label="打开笔记存储目录" title="打开笔记存储目录" onClick={() => openFolder()}>
            <FolderOpen size={15} />
          </button>
        </div>
        <div className="section-label">
          <span>
            我的知识库 <b>{noteCount(notes)}</b>
          </span>
          <button aria-label="新建笔记" title="新建笔记" onClick={() => void createNote()}>
            <Plus size={15} />
          </button>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            aria-label="搜索笔记"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索笔记…"
          />
          <kbd>⌕</kbd>
        </label>
        <div className="file-list">
          {search ? (
            <div className="search-results">
              {hits.map((hit) => (
                <button key={hit.path} onClick={() => void openNote(hit.path)}>
                  <FileText size={15} />
                  <div>
                    <strong>{hit.name.replace(/\.md$/i, '')}</strong>
                    <small>{hit.snippet}</small>
                  </div>
                </button>
              ))}
              {!hits.length && <p className="muted small">没有匹配的笔记</p>}
            </div>
          ) : (
            <Tree
              data={notes}
              width={Math.max(145, leftWidth - 28)}
              height={280}
              rowHeight={32}
              indent={14}
              openByDefault
              disableDrag
              disableDrop
              disableEdit
              onActivate={(node) => {
                if (node.isLeaf) void openNote(node.data.path);
              }}
            >
              {FileNode}
            </Tree>
          )}
        </div>
        <div className="section-label">
          <span>最近学习</span>
          <Clock3 size={13} />
        </div>
        <div className="recent-list">
          {state?.sources.slice(0, 3).map((item) => (
            <button
              key={item.id}
              title={item.title}
              onClick={() => {
                setMode('browser');
                void api.openSource(item.id).then(setState, (cause) => setError(textOf(cause)));
              }}
            >
              <Video size={14} />
              <span>{item.title}</span>
              <ArrowUpRight size={12} />
            </button>
          ))}
          {!state?.sources.length && <p className="muted small">打开课程后，来源会保存在这里。</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="local-label">
            <ShieldCheck size={14} />
            <span>笔记保存在本地</span>
            <span className="connected-dot" />
          </div>
          <button
            className="vault-button"
            onClick={() => void chooseVault()}
            title={state?.vaultPath}
            disabled={switchingVault}
          >
            <FolderOpen size={15} />
            <span>{switchingVault ? '正在索引…' : '切换知识库'}</span>
            <ArrowUpRight size={13} />
          </button>
          <small title={state?.vaultPath}>{state?.vaultPath || '正在连接知识库…'}</small>
        </div>
      </aside>
      {!collapsed && (
        <ResizeHandle
          label="调整目录宽度"
          value={leftWidth}
          min={180}
          max={Math.min(480, windowWidth * 0.4)}
          onChange={setLeftWidth}
          onResizing={setResizing}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          <div>
            <button
              className="icon-button"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              onClick={() => setCollapsed(!collapsed)}
            >
              <PanelLeftClose size={17} />
            </button>
            <span className="breadcrumb">
              工作空间 <ChevronRight size={13} />{' '}
              <strong>
                {mode === 'home'
                  ? '学习工作台'
                  : mode === 'document'
                    ? '文档阅读'
                    : mode === 'note'
                      ? '我的笔记'
                      : mode === 'analysis'
                        ? '视频解析'
                        : '课程浏览器'}
              </strong>
              {mode === 'note' && document && (
                <span className="breadcrumb-sub">{document.path.split('/').pop()}</span>
              )}
              {mode === 'document' && docActive.main && (
                <span className="breadcrumb-sub">
                  {state?.documents?.find((d) => d.id === docActive.main)?.title}
                </span>
              )}
            </span>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span className="connected-dot" />
              本地工作台已连接
            </span>
            <button className="icon-button" aria-label="使用说明" onClick={() => setHelpOpen(!helpOpen)}>
              <CircleHelp size={17} />
            </button>
            <span className="avatar">学</span>
          </div>
        </header>
        <div className="workspace-body">
          <main
            className="reader"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/x-study-tab')) event.preventDefault();
            }}
            onDrop={(event) => dropTab(event, 'main')}
          >
            <div className="tabs">
              {documentTabs('main')}
              <button className={mode === 'home' ? 'tab current' : 'tab'} onClick={() => setMode('home')}>
                <BookOpen size={14} />
                工作台
              </button>
              {state?.activeBinding && (
                <button
                  className={mode === 'browser' ? 'tab current' : 'tab'}
                  onClick={() => setMode('browser')}
                >
                  <Globe2 size={14} />
                  <span
                    draggable={false}
                    onPointerDown={(event) => dragTab(event, 'video')}
                    onDragStart={(event) => event.preventDefault()}
                  >
                    {source?.title || '课程浏览器'}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="视频移到右侧"
                    onClick={(event) => {
                      event.stopPropagation();
                      dockVideo();
                    }}
                  >
                    ⇥
                  </span>
                </button>
              )}
              {desk.desk.main.tabs.map((path) => (
                <button
                  key={path}
                  draggable={false}
                  onPointerDown={(event) => dragTab(event, 'note', path, 'main')}
                  onDragStart={(event) => event.preventDefault()}
                  className={mode === 'note' && document?.path === path ? 'tab current' : 'tab'}
                  onClick={() => void openNote(path)}
                  title={path}
                >
                  <FileText size={14} />
                  <span>{path.split('/').pop()?.replace(/\.md$/i, '')}</span>
                  {isDirty(desk.desk.sessions[path]) && <i className="dirty-dot" />}
                  <span
                    role="button"
                    tabIndex={0}
                    className="tab-close"
                    aria-label={'关闭笔记 ' + path}
                    onClick={(event) => {
                      event.stopPropagation();
                      desk.close('main', path);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation();
                        desk.close('main', path);
                      }
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              ))}
              {state?.analysis && (
                <button
                  className={mode === 'analysis' ? 'tab current' : 'tab'}
                  onClick={() => setMode('analysis')}
                >
                  <Video size={14} />
                  解析结果
                </button>
              )}
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button aria-label="关闭提示" onClick={() => setError('')}>
                  <X size={15} />
                </button>
              </div>
            )}
            {(loadingNote || switchingVault) && (
              <div className="note-load-status">
                {switchingVault ? '正在扫描笔记目录并连接知识库，可继续阅读当前内容…' : '正在读取笔记…'}
              </div>
            )}
            {mode === 'document' && docActive.main && (
              <DocumentPane
                onAskImage={askOriginalImage}
                key={docActive.main}
                id={docActive.main}
                initialPage={docPage[docActive.main]}
                onContext={(value) => {
                  setDocContext(value);
                  setDocPage((prev) =>
                    prev[value.id] === value.page ? prev : { ...prev, [value.id]: value.page },
                  );
                }}
                onDock={() => moveDocument(docActive.main!, 'main', 'side')}
              />
            )}
            {mode === 'home' && (
              <div className="home">
                <div className="home-container">
                  <div className="eyebrow">
                    <span />A LITTLE LEARNING, EVERY DAY · AI-NATIVE WORKBENCH
                  </div>
                  <h1>
                    专注眼前这课，
                    <br />
                    留下真正理解的笔记<span>。</span>
                  </h1>
                  <p className="home-description">
                    阅读器的沉浸优雅、IDE 的多栏灵活与 AI 原生工作台的按需推理，融于同一处本地空间。
                    <br />
                    让每一次「原来如此」，都有迹可循。
                  </p>
                  <form
                    className="course-entry"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void openWeb();
                    }}
                  >
                    <div className="entry-label">
                      <span className="course-icon">
                        <Video size={19} />
                      </span>
                      <div>
                        <strong>从一段课程开始</strong>
                        <small>粘贴 B站或含视频的网页地址，开启无感伴学观察</small>
                      </div>
                      <span className="light-badge">只读观察</span>
                    </div>
                    <div className="entry-input">
                      <Globe2 size={17} />
                      <input
                        aria-label="课程地址"
                        placeholder="https://www.bilibili.com/video/…"
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                      />
                      <button type="submit" disabled={loadingWeb}>
                        {loadingWeb ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <>
                            打开课程 <ArrowRight size={15} />
                          </>
                        )}
                      </button>
                    </div>
                    <div className="entry-hint">
                      <ShieldCheck size={13} />
                      后台记录进度与画面，不改变你的播放操作
                    </div>
                  </form>
                  <div className="quick-actions">
                    <button onClick={() => void openLocal()}>
                      <span className="action-icon green">
                        <Video size={20} />
                      </span>
                      <strong>打开本地视频</strong>
                      <small>内置播放与后台画面解析</small>
                      <ArrowUpRight size={16} />
                    </button>
                    <button onClick={() => void importNotes()}>
                      <span className="action-icon warm">
                        <ArrowDownToLine size={20} />
                      </span>
                      <strong>导入 Markdown</strong>
                      <small>保留原文件，同名自动创建副本</small>
                      <ArrowUpRight size={16} />
                    </button>
                    <button onClick={() => void createNote()}>
                      <span className="action-icon warm">
                        <FilePlus2 size={20} />
                      </span>
                      <strong>写一篇新笔记</strong>
                      <small>把刚刚想明白的记下来</small>
                      <ArrowUpRight size={16} />
                    </button>
                    <button onClick={() => void chooseVault()}>
                      <span className="action-icon green">
                        <FolderOpen size={20} />
                      </span>
                      <strong>打开已有知识库</strong>
                      <small>继续使用你的 Markdown 文件</small>
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                  <div className="learning-flow">
                    <div>
                      <span>01</span>
                      <strong>阅读</strong>
                      <small>保持自己的学习节奏</small>
                    </div>
                    <ChevronRight size={15} />
                    <div>
                      <span>02</span>
                      <strong>理解</strong>
                      <small>把提问落在具体进度</small>
                    </div>
                    <ChevronRight size={15} />
                    <div>
                      <span>03</span>
                      <strong>沉淀</strong>
                      <small>留下可继续编辑的笔记</small>
                    </div>
                  </div>
                  <div className="build-note">
                    <Zap size={15} />
                    <p>
                      <strong>内置视频解析已就绪</strong>
                      <span>
                        笔记、视频、PDF/课件与 AI 问答已接入。点击右侧齿轮，选择 API 或 ChatGPT 订阅授权。
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            )}
            {mode === 'analysis' && state?.analysis && (
              <section className="analysis-page">
                <span className="eyebrow">
                  <span />
                  NATIVE VIDEO ANALYSIS
                </span>
                <h1>视频解析</h1>
                <p className="analysis-source">{state.analysis.title}</p>
                <div className="analysis-meta">
                  <span>内置 Chromium 解码</span>
                  <span>
                    {state.analysis.width} × {state.analysis.height}
                  </span>
                  <span>
                    {time(state.analysis.duration)} · {state.analysis.frames.length} 帧
                  </span>
                </div>
                <p className="muted">
                  画面按指定范围均匀提取；不包含语音转录。独立后台解码不改变课程播放器进度。
                </p>
                <div className="analysis-gallery">
                  {state.analysis.frames.map((frame) => (
                    <figure key={frame.id}>
                      <img src={frame.data!} alt={'解析画面 ' + time(frame.timestamp)} />
                      <figcaption>
                        <strong>{time(frame.timestamp)}</strong>
                        <span>
                          {frame.width} × {frame.height}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <button className="primary" onClick={() => openFolder()}>
                  打开笔记目录 <FolderOpen size={15} />
                </button>
              </section>
            )}
            {mode === 'browser' && (
              <div className="browser-pane">
                <form
                  className="address-bar"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void openWeb();
                  }}
                >
                  <Globe2 size={15} />
                  <input
                    aria-label="浏览器地址"
                    value={address}
                    placeholder="输入完整课程网页地址"
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  <button type="submit" disabled={loadingWeb} aria-label="前往网页">
                    {loadingWeb ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={17} />}
                  </button>
                  {state?.activeBinding && (
                    <button
                      type="button"
                      aria-label="关闭课程"
                      onClick={() => {
                        void api.closeWeb();
                        setMode('home');
                      }}
                    >
                      <X size={16} />
                    </button>
                  )}
                </form>
                <VideoControls active={!!state?.activeBinding && videoLocation === 'main'} />
                <div className="browser-surface" ref={videoLocation === 'main' ? browserBox : undefined}>
                  {videoLocation === 'side' && state?.activeBinding && (
                    <div className="browser-empty">
                      <p>视频正在右侧播放</p>
                      <button
                        className="primary"
                        onClick={() => {
                          setVideoLocation('main');
                          setMode('browser');
                        }}
                      >
                        移回工作区
                      </button>
                    </div>
                  )}
                  {!state?.activeBinding && (
                    <div className="browser-empty">
                      <span className="empty-icon">
                        <Globe2 size={34} />
                      </span>
                      <h2>打开你正在学习的课程</h2>
                      <p>
                        在上方输入网页地址。视频开始播放后，
                        <br />
                        右侧将同步当前进度和可用证据。
                      </p>
                      <button className="primary" onClick={() => void openWeb('https://www.bilibili.com/')}>
                        打开哔哩哔哩 <ArrowUpRight size={15} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="reader-status">
                  <span className="connected-dot" />
                  {playback
                    ? playback.paused
                      ? '视频已暂停 · 观察保持只读'
                      : '视频播放中 · 后台观察'
                    : '等待页面中的视频'}
                  <span>
                    {playback
                      ? time(playback.currentTime) + ' / ' + time(playback.duration)
                      : '不读取浏览器凭据'}
                  </span>
                </div>
              </div>
            )}
            {mode === 'note' && (
              <NotePane
                desk={desk}
                pane="main"
                vaultId={state?.vaultId || ''}
                error={error}
                onNavigate={navigate}
                onDock={() => {
                  if (document) dockNote(document.path, 'main');
                }}
              />
            )}
          </main>
          <ResizeHandle
            label="调整右侧宽度"
            value={rightWidth}
            min={280}
            max={Math.max(320, windowWidth - (collapsed ? 0 : leftWidth) - 330)}
            reverse
            onChange={setRightWidth}
            onResizing={setResizing}
          />
          <aside
            className={'companion ' + (dockOpen ? 'compact-ai ' : '') + (dragging ? 'accept-drop' : '')}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/x-study-tab')) event.preventDefault();
            }}
            onDrop={(event) => dropTab(event, 'side')}
          >
            {dragging && <div className="dock-drop-hint">松开标签，在这里并排查看 · Esc 取消</div>}
            {(docTabs.side.length > 0 ||
              desk.desk.side.tabs.length > 0 ||
              (videoLocation === 'side' && state?.activeBinding)) && (
              <div
                className="study-dock"
                style={{ height: studyHeight }}
                onPointerDown={() => desk.focus('side')}
              >
                <div className="tabs side-tabs">
                  {documentTabs('side')}
                  {videoLocation === 'side' && state?.activeBinding && (
                    <button
                      className={dockActive === 'video' ? 'tab current' : 'tab'}
                      draggable={false}
                      onPointerDown={(event) => dragTab(event, 'video', '', 'side')}
                      onDragStart={(event) => event.preventDefault()}
                      onClick={() => setDockActive('video')}
                    >
                      <Video size={14} />
                      <span>{source?.title || '视频'}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="视频移回工作区"
                        onClick={(event) => {
                          event.stopPropagation();
                          setVideoLocation('main');
                          setMode('browser');
                        }}
                      >
                        ⇤
                      </span>
                    </button>
                  )}
                  {desk.desk.side.tabs.map((path) => (
                    <button
                      key={path}
                      className={
                        dockActive === 'note' && desk.desk.side.active === path ? 'tab current' : 'tab'
                      }
                      draggable={false}
                      onPointerDown={(event) => dragTab(event, 'note', path, 'side')}
                      onDragStart={(event) => event.preventDefault()}
                      onClick={() => {
                        void desk.open(path, '', 'side');
                        setDockActive('note');
                      }}
                      title={path}
                    >
                      <FileText size={14} />
                      <span>{path.split('/').pop()?.replace(/\.md$/i, '')}</span>
                      {isDirty(desk.desk.sessions[path]) && <i className="dirty-dot" />}
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={'关闭右侧笔记 ' + path}
                        onClick={(event) => {
                          event.stopPropagation();
                          desk.close('side', path);
                        }}
                      >
                        <X size={12} />
                      </span>
                    </button>
                  ))}
                </div>
                {dockActive === 'document' && docActive.side ? (
                  <DocumentPane
                    key={docActive.side}
                    id={docActive.side}
                    initialPage={docPage[docActive.side]}
                    onContext={(value) => {
                      setDocContext(value);
                      setDocPage((prev) =>
                        prev[value.id] === value.page ? prev : { ...prev, [value.id]: value.page },
                      );
                    }}
                    onDock={() => moveDocument(docActive.side!, 'side', 'main')}
                  />
                ) : dockActive === 'note' ? (
                  <NotePane
                    desk={desk}
                    pane="side"
                    vaultId={state?.vaultId || ''}
                    error={error}
                    onNavigate={navigate}
                    onDock={() => {
                      const path = desk.desk.side.active;
                      if (path) dockNote(path, 'side');
                    }}
                  />
                ) : (
                  <div className="docked-browser">
                    <VideoControls active={dockActive === 'video' && !!state?.activeBinding} />
                    <div className="browser-surface" ref={browserBox} />
                    <div className="reader-status">
                      {source?.title}
                      <span>{playback ? time(playback.currentTime) : '等待视频'}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            {dockOpen && (
              <ResizeHandle
                label="调整右侧学习区高度"
                axis="y"
                value={studyHeight}
                min={180}
                max={Math.max(260, window.innerHeight - 300)}
                onChange={setStudyHeight}
                onResizing={setResizing}
              />
            )}

            <details className="course-toolbox" open={!dockOpen && !!playback && !aiHasMessages}>
              <summary>
                <Video size={14} />
                课程工具与学习证据
                <ChevronDown size={13} />
              </summary>
              <div className="companion-scroll">
                <div className="context-status">
                  <div>
                    <span className={playback ? 'connected-dot' : 'idle-dot'} />
                    <strong>{playback ? '已连接当前课程' : '等待学习内容'}</strong>
                    <span>{playback ? time(playback.currentTime) : '—:—'}</span>
                  </div>
                  <p>{source?.title || '打开一段课程，让上下文跟上你的思路。'}</p>
                  {playback && (
                    <div className="evidence-count">
                      <span>
                        <Video size={12} />
                        {playback.frameCount} 帧
                      </span>
                      <span>
                        <FileText size={12} />
                        {playback.subtitleCount} 条字幕
                      </span>
                    </div>
                  )}
                </div>
                <button
                  className="context-button"
                  disabled={!playback || running}
                  onClick={() => {
                    setError('');
                    void api.captureContext().catch((cause) => setError(textOf(cause)));
                  }}
                >
                  {running ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
                  读取课程上下文
                  <ArrowRight size={14} />
                </button>
                <section className="media-controls">
                  <h3>
                    <Video size={15} />
                    视频解析
                  </h3>
                  <p>输入秒数指定范围；终点留空则解析到片尾。</p>
                  <div className="media-range">
                    <label>
                      起点（秒）
                      <input
                        aria-label="解析起点"
                        type="number"
                        min="0"
                        step="0.1"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                      />
                    </label>
                    <label>
                      终点（秒）
                      <input
                        aria-label="解析终点"
                        type="number"
                        min="0"
                        step="0.1"
                        placeholder="片尾"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                      />
                    </label>
                    <label>
                      画面数
                      <select
                        aria-label="解析画面数"
                        value={frameCount}
                        onChange={(e) => setFrameCount(e.target.value)}
                      >
                        {[3, 6, 9, 12].map((n) => (
                          <option key={n} value={n}>
                            {n} 帧
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    className="context-button"
                    disabled={!state?.activeBinding || running}
                    onClick={() => void analyze()}
                  >
                    <Video size={15} />
                    后台解析视频
                    <ArrowRight size={14} />
                  </button>
                  <small>无需额外安装工具 · 不影响前台播放</small>
                  {state?.analysis && (
                    <button className="analysis-link" onClick={() => setMode('analysis')}>
                      查看解析结果（{state.analysis.frames.length} 帧）
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                </section>
                {state?.context && (
                  <div className="context-result">
                    <div className="result-title">
                      <CheckCheck size={15} />
                      <strong>已冻结本次上下文</strong>
                      <span>{time(state.context.anchor.mediaTime)}</span>
                    </div>
                    <p className="context-source">{state.context.anchor.sourceTitle}</p>
                    <div className="frame-grid">
                      {state.context.frames
                        .filter((f) => f.data)
                        .map((frame) => (
                          <figure key={frame.id}>
                            <img src={frame.data!} alt={'课程画面 ' + time(frame.timestamp)} />
                            <figcaption>{time(frame.timestamp)}</figcaption>
                          </figure>
                        ))}
                    </div>
                    {state.context.subtitles.slice(-4).map((s, index) => (
                      <p className="subtitle" key={index}>
                        <span>{time(s.from)}</span>
                        {s.text}
                      </p>
                    ))}
                    {state.context.gaps.map((gap) => (
                      <p className="gap-note" key={gap}>
                        {gap}
                      </p>
                    ))}
                  </div>
                )}
                {!!state?.tasks.length && (
                  <div className="task-list">
                    <h3>最近任务</h3>
                    {state.tasks.slice(0, 3).map((task) => (
                      <div className="task" key={task.id}>
                        <span className={'task-indicator ' + task.status}>
                          {task.status === 'running' ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : task.status === 'succeeded' ? (
                            <Check size={13} />
                          ) : (
                            <Clock3 size={13} />
                          )}
                        </span>
                        <span>
                          {task.label}
                          <small>{task.error || taskLabels[task.status]}</small>
                        </span>
                        {['queued', 'running'].includes(task.status) && (
                          <button aria-label="取消任务" onClick={() => void api.cancelTask(task.id)}>
                            <Square size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
            <AiPanel
              externalPrompt={aiDraft}
              onOpenVideo={(id, targetTime) => void openVideoEvidence(id, targetTime)}
              documentContext={
                mode === 'document' || (dockOpen && dockActive === 'document') ? docContext : undefined
              }
              onOpenDocument={(id, page) => activateDocument(id, page)}
              onConversation={setAiHasMessages}
              note={desk.desk[desk.desk.focused].active}
              vaultId={state?.vaultId || ''}
              courseAvailable={!!state?.playback}
              onSettings={setAiSettingsOpen}
              dirtyPaths={Object.entries(desk.desk.sessions)
                .filter(([, s]) => isDirty(s))
                .map(([p]) => p)}
              onNoteChange={(path) => {
                if (desk.desk.sessions[path] && !isDirty(desk.desk.sessions[path])) void desk.reload(path);
              }}
              onOpenNote={(path) => {
                void desk.open(path);
              }}
            />
          </aside>
        </div>
        <footer className="app-status">
          <span>
            <span className="connected-dot" />
            核心服务运行中
            <span className="footer-separator">·</span>
            <span>阅读 · IDE 多栏 · AI 原生工作台</span>
          </span>
          <span>
            {state?.version || '正在初始化…'}
            <span className="footer-separator">·</span>D 盘本地存储
          </span>
        </footer>
      </div>
      {desk.closing && (
        <div className="modal-overlay">
          <section
            className="help-modal close-note-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="关闭未保存笔记"
          >
            <h2>保留这篇笔记的修改？</h2>
            <p>{desk.closing.path}</p>
            <div className="dialog-actions">
              <button onClick={() => desk.setClosing(null)}>继续编辑</button>
              <button onClick={() => desk.close(desk.closing!.pane, desk.closing!.path, true)}>
                放弃修改
              </button>
              <button
                className="primary"
                onClick={() => {
                  const request = desk.closing!;
                  void desk.save(request.path).then((ok) => {
                    if (ok) desk.close(request.pane, request.path, true);
                  });
                }}
              >
                保存并关闭
              </button>
            </div>
          </section>
        </div>
      )}
      {learningOpen && (
        <LearningPanel
          onAskImage={askOriginalImage}
          state={state}
          note={desk.desk[desk.desk.focused].active}
          onClose={() => setLearningOpen(false)}
          onOpenNote={(path) => void openNote(path)}
          onDocument={(id, page) => {
            setLearningOpen(false);
            activateDocument(id, page);
          }}
          onVideo={(id, targetTime) => {
            setLearningOpen(false);
            void openVideoEvidence(id, targetTime);
          }}
        />
      )}
      {helpOpen && (
        <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-label="开始使用"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭说明"
              onClick={() => setHelpOpen(false)}
            >
              <X size={19} />
            </button>
            <span className="action-icon green">
              <BookOpen size={24} />
            </span>
            <h2>从正在学的内容开始</h2>
            <p>
              打开视频网页，播放后等待进度同步，再点击右侧「读取课程上下文」。整个观察过程不会控制播放器。
            </p>
            <p>
              可导入外部 UTF-8 Markdown 文件或选择已有笔记文件夹；同名导入自动保留副本。图片附件不会随
              Markdown 一起复制。点击文件夹图标可打开本地目录。应用缓存、临时文件与备份保存在 D 盘。
            </p>
            <p>
              笔记支持公式、Mermaid
              图表、双链、图片、Callout、脚注与块引用。可切换阅读、分栏和源码；长文先显示首屏，余文后台排版。点击目录快速跳到章节，图表可放大查看。
            </p>
            <p>
              打开本地视频或
              B站课程后，可在右侧解析指定范围画面，后台独立解码。受权限限制的视频及部分编码可能不可解析，可继续读取已观察的上下文。右侧齿轮可设置模型，支持
              API 与 ChatGPT 订阅 SIWC。左侧可打开 PDF 或 PowerPoint，按页提问并点回来源；本地采音、OCR
              与全库检索可在「识别与全库检索」中使用。
            </p>
            <button className="primary" onClick={() => setHelpOpen(false)}>
              开始学习 <ArrowRight size={15} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
