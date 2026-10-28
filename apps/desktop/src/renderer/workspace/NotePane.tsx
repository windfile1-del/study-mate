import MDEditor from '@uiw/react-md-editor';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  FolderOpen,
  LoaderCircle,
  PanelRightOpen,
  RefreshCw,
  History,
  Save,
} from 'lucide-react';
import { NotePreview } from '../notes/NotePreview';
import { isDirty, type Pane } from './note-desk';
import type { NoteDesk } from './useNoteDesk';
import{SynchronizedEditor}from'./SynchronizedEditor';
export function NotePane({
  desk,
  pane,
  vaultId,
  onNavigate,
  onDock,
  error,
}: {
  desk: NoteDesk;
  pane: Pane;
  vaultId: string;
  error: string;
  onNavigate: (target: string, wiki: boolean, base: string, pane: Pane) => void;
  onDock: () => void;
}) {
  const session = desk.active(pane);
  if (!session) return <div className="pane-empty">从目录打开笔记，或将标签拖到这里。</div>;
  const { document, content } = session,
    path = document.path;
  const state = desk.desk[pane],
    view = state.views[path] || session.initialView;
  const anchor = state.history[state.cursor]?.path === path ? state.history[state.cursor].anchor : '';
  const saving = desk.saving.includes(path),
    dirty = isDirty(session);
  const preview = (source: string) => (
    <NotePreview
      key={pane + ':' + path}
      restoreScope={pane}
      source={source}
      path={path}
      vaultId={vaultId}
      anchor={anchor}
      initialOffset={desk.position(pane, path)}
      onOffset={(value) => desk.remember(pane, path, value)}
      onNavigate={(target, wiki, base) => onNavigate(target, wiki, base || path, pane)}
    />
  );
  return (
    <div
      className="note-pane"
      data-pane={pane}
      onPointerDown={() => desk.focus(pane)}
      onFocusCapture={() => desk.focus(pane)}
    >
      <div className="note-toolbar">
        <span title={path}>
          <FileText size={15} />
          {path}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="返回上一篇笔记"
            title="返回 · Alt+←"
            disabled={state.cursor <= 0}
            onClick={() => void desk.history(pane, -1)}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="前进到下一篇笔记"
            title="前进 · Alt+→"
            disabled={state.cursor >= state.history.length - 1}
            onClick={() => void desk.history(pane, 1)}
          >
            <ArrowRight size={16} />
          </button>
          <div className="note-view-modes" aria-label="笔记显示模式">
            {(
              [
                ['preview', '阅读'],
                ['live', '分栏'],
                ['edit', '源码'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={view === value ? 'active' : ''}
                aria-label={label + '模式'}
                aria-pressed={view === value}
                onClick={() => desk.view(pane, path, value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            aria-label={pane === 'main' ? '笔记移到右侧' : '笔记移回工作区'}
            title={pane === 'main' ? '移到右侧并排查看' : '移回工作区'}
            onClick={onDock}
          >
            <PanelRightOpen size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="在文件夹中显示笔记"
            onClick={() => void window.studyMate.openFolder(path)}
          >
            <FolderOpen size={15} />
          </button>
          <small>{dirty ? '有未保存的修改' : '已保存到本地'}</small>
          {dirty && error && (
            <button className="primary" onClick={() => void desk.copy(path, pane)}>
              另存副本
            </button>
          )}
          <button className="icon-button" aria-label="重新读取笔记" onClick={() => void desk.reload(path)}>
            <RefreshCw size={15} />
          </button>
          <button className="icon-button" aria-label="管理当前笔记备份" title="预览、恢复与清理自动备份" onClick={()=>window.dispatchEvent(new CustomEvent('study-library-manage',{detail:{path}}))}><History size={15}/></button>
          <button className="primary" onClick={() => void desk.save(path)} disabled={!dirty || saving}>
            {saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存 <kbd>Ctrl S</kbd>
          </button>
        </div>
      </div>
      <SynchronizedEditor scope={vaultId+':'+path} anchor={anchor}>
        {view === 'preview' ? (
          preview(content)
        ) : (
          <MDEditor
            value={content}
            height="100%"
            visibleDragbar={false}
            preview={view}
            extraCommands={[]}
            highlightEnable={content.length < 60000}
            components={{ preview }}
            textareaProps={{ 'aria-label': 'Markdown 笔记内容', readOnly: saving }}
            onChange={(value) => desk.edit(path, value || '')}
          />
        )}
      </SynchronizedEditor>
      <div className="reader-status">
        <Check size={13} />
        普通 Markdown · 草稿随标签保留<span>{content.length} 字符 · UTF-8</span>
      </div>
    </div>
  );
}
