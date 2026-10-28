import { useEffect, useRef, useState } from 'react';
import { Pin, PanelRightClose, X } from 'lucide-react';
import { AiPanel } from '../ai/AiPanel';
import { NavigationPanel, type NavigationAction } from './NavigationPanel';
import type { PanelKind, PanelState } from '../../shared/panels';
import type { AppState, NoteFile } from '../../shared/contracts';
export function FloatingHost({ kind }: { kind: PanelKind }) {
  const [snapshot, setSnapshot] = useState<PanelState | null>(null),
    [state, setState] = useState<AppState | null>(null),
    [notes, setNotes] = useState<NoteFile[]>([]),
    [error, setError] = useState(''),
    [width, setWidth] = useState(window.innerWidth);
  const revision = useRef('');
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const data = await window.studyMate.state();
        if (!live) return;
        setState(data);
        const key = data.vaultId + ':' + data.vaultRevision;
        if (key !== revision.current) {
          revision.current = key;
          const rows = await window.studyMate.listNotes();
          if (live) setNotes(rows);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void refresh();
    void window.studyMate.panel({ action: 'state' }).then((value) => {
      if (live) setSnapshot(value);
    });
    const off = window.studyMate.onChanged(() => void refresh()),
      offPanel = window.studyMate.onPanelEvent((e) => {
        if (live && e.state) setSnapshot(e.state);
      });
    return () => {
      live = false;
      off();
      offPanel();
    };
  }, []);
  const navigate = (target: NavigationAction, id?: string, page?: number) =>
    void window.studyMate.panel({ action: 'navigate', target, id, page });
  const ctx = snapshot?.context,
    pinned = !!snapshot?.panels[kind].pinned;
  return (
    <div className={'floating-host ' + (pinned ? 'pinned' : '')}>
      <header className="floating-header">
        <strong>{kind === 'assistant' ? '伴学助手 · 悬浮' : '资料导航 · 悬浮'}</strong>
        <div>
          <button
            aria-label="固定悬浮窗"
            title={pinned ? '取消置顶' : '固定置顶'}
            className={pinned ? 'active' : ''}
            onClick={() => void window.studyMate.panel({ action: 'pin', kind, enabled: !pinned })}
          >
            <Pin size={14} />
          </button>
          <button
            aria-label="返回工作台侧栏"
            title="返回工作台侧栏"
            onClick={() => void window.studyMate.panel({ action: 'dock', kind })}
          >
            <PanelRightClose size={14} />
          </button>
          <button
            aria-label="关闭悬浮窗"
            onClick={() => void window.studyMate.panel({ action: 'close', kind })}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {kind === 'assistant' && (
        <div className="floating-note-context">
          {ctx?.note ? '当前笔记 · ' + ctx.note : '选中主工作台资料后，可在这里提问'}
        </div>
      )}
      <div className="floating-body">
        {kind === 'navigation' ? (
          <NavigationPanel state={state} notes={notes} width={width} onAction={navigate} />
        ) : (
          <AiPanel
            workspace={ctx?.workspace||[]}
            note={ctx?.note || null}
            vaultId={ctx?.vaultId || state?.vaultId || ''}
            documentContext={ctx?.document}
            externalPrompt={ctx?.externalPrompt}
            dirtyPaths={ctx?.dirtyPaths || []}
            courseAvailable={!!state?.playback}
            onSettings={(expanded) => void window.studyMate.panel({ action: 'form', kind, expanded })}
            onConversation={() => {}}
            onOpenNote={(path) => navigate('note', path)}
            onNoteChange={(path) => navigate('note-changed', path)}
            onOpenDocument={(id, page) => navigate('document', id, page)}
            onOpenVideo={(id, time) => navigate('video', id, time)}
          />
        )}
      </div>
    </div>
  );
}
