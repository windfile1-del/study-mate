import { useEffect, useRef, useState } from 'react';
import { Tree, type NodeRendererProps } from 'react-arborist';
import {
  Leaf,
  LayoutDashboard,
  Globe2,
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ArrowDownToLine,
  Plus,
  Video,
  Sparkles,
  ExternalLink,
  Search,
  LibraryBig,
  MonitorPlay,
} from 'lucide-react';
import type { AppState, NoteFile, SearchHit } from '../../shared/contracts';
import './panels.css';
export type NavigationAction =
  | 'home'
  | 'browser'
  | 'note'
  | 'document'
  | 'video'
  | 'import-notes'
  | 'create-note'
  | 'vault'
  | 'manage'
  | 'learning'
  | 'open-folder'
  | 'open-document'
  | 'open-local'
  | 'note-changed';
export function NavigationPanel({
  state,
  notes,
  width = 260,
  onAction,
  onFloat,
}: {
  state: AppState | null;
  notes: NoteFile[];
  width?: number;
  onAction: (target: NavigationAction, id?: string, page?: number) => void;
  onFloat?: () => void;
}) {
  const [tab, setTab] = useState<'notes' | 'documents' | 'courses'>(
      () => (localStorage.getItem('study-navigation-v1') as any) || 'notes',
    ),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<SearchHit[]>([]),
    [height, setHeight] = useState(280);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(Math.max(100, node.clientHeight)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab]);
  useEffect(() => {
    localStorage.setItem('study-navigation-v1', tab);
    setQuery('');
  }, [tab]);
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === 'study-navigation-v1' && ['notes', 'documents', 'courses'].includes(e.newValue || ''))
        setTab(e.newValue as any);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  useEffect(() => {
    if (tab !== 'notes' || !query.trim()) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(
      () =>
        void window.studyMate
          .searchNotes(query)
          .then((rows) => {
            if (live) setHits(rows);
          })
          .catch(() => {}),
      150,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, tab, state?.vaultId, state?.vaultRevision, state?.knowledge?.files, state?.knowledge?.embedding]);
  const count = (rows: NoteFile[]): number =>
    rows.reduce((n, r) => n + (r.children ? count(r.children) : 1), 0);
  return (
    <aside className="sidebar navigation-panel">
      <div className="brand">
        <span className="brand-mark">
          <Leaf size={20} />
        </span>
        <div>
          <strong>Study Mate</strong>
          <span>让理解，慢慢生长</span>
        </div>
        {onFloat && (
          <button
            className="navigation-popout"
            aria-label="导航悬浮窗"
            title="将导航变成可移动浮窗"
            onClick={onFloat}
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>
      <nav className="navigation-global">
        <button className="nav-item" onClick={() => onAction('home')}>
          <LayoutDashboard size={16} />
          学习工作台
        </button>
        <button className="nav-item" onClick={() => onAction('browser')}>
          <Globe2 size={16} />
          课程浏览器
        </button>
      </nav>
      <div className="navigation-tabs" role="tablist" aria-label="资料分类">
        {(
          [
            ['notes', '笔记', FileText],
            ['documents', '文档', LibraryBig],
            ['courses', '课程', MonitorPlay],
          ] as const
        ).map(([key, title, Icon]) => (
          <button
            key={key}
            role="tab"
            aria-label={title + '分类'}
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            <Icon size={15} />
            {title}
          </button>
        ))}
      </div>
      <div className="navigation-section-heading">
        <strong>{tab === 'notes' ? '我的知识库' : tab === 'documents' ? '文档资料' : '视频课程'}</strong>
        <span>
          {tab === 'notes'
            ? count(notes)
            : tab === 'documents'
              ? state?.documents.length || 0
              : state?.sources.length || 0}
        </span>
      </div>
      <div className="navigation-actions">
        {tab === 'notes' ? (
          <>
            <button onClick={() => onAction('import-notes')}>
              <ArrowDownToLine size={14} />
              导入 Markdown
            </button>
            <button aria-label="新建笔记" title="新建笔记" onClick={() => onAction('create-note')}>
              <Plus size={15} />
            </button>
          </>
        ) : tab === 'documents' ? (
          <button onClick={() => onAction('open-document')}>
            <Plus size={14} />
            打开 PDF / PowerPoint
          </button>
        ) : (
          <button onClick={() => onAction('open-local')}>
            <Plus size={14} />
            打开本地视频
          </button>
        )}
      </div>
      <label className="search">
        <Search size={14} />
        <input
          aria-label={tab === 'notes' ? '搜索笔记' : tab === 'documents' ? '查找文档' : '查找课程'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            tab === 'notes' ? '搜索笔记…' : tab === 'documents' ? '按课件名称查找…' : '按课程名称查找…'
          }
        />
      </label>
      <div className="navigation-resource-list file-list" ref={list}>
        {tab === 'notes' ? (
          query ? (
            <div className="search-results">
              {hits.map((hit) => (
                <button key={hit.path} onClick={() => onAction('note', hit.path)}>
                  <FileText size={15} />
                  <div>
                    <strong>{hit.name.replace(/\.md$/, '')}</strong>
                    <small>{hit.snippet}</small>
                  </div>
                </button>
              ))}
              {!hits.length && <p className="navigation-empty">没有匹配的笔记</p>}
            </div>
          ) : (
            <Tree
              data={notes}
              width={Math.max(180, width - 28)}
              height={height}
              rowHeight={32}
              indent={14}
              openByDefault
              disableDrag
              disableDrop
              disableEdit
              onActivate={(node) => {
                if (node.isLeaf) onAction('note', node.data.path);
              }}
            >
              {NavigationNode}
            </Tree>
          )
        ) : tab === 'documents' ? (
          <div className="resource-list">
            {state?.documents
              .filter((d) => d.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
              .map((d) => (
                <button
                  className="resource-card"
                  title={d.title}
                  key={d.id}
                  onClick={() => onAction('document', d.id)}
                >
                  <span className={'resource-format ' + d.kind}>{d.kind === 'pdf' ? 'PDF' : 'PPT'}</span>
                  <span>
                    <strong>{d.title}</strong>
                    <small>
                      {d.pages} 页 · 上次第 {d.lastPage} 页
                    </small>
                  </span>
                </button>
              ))}
            {!state?.documents.length && (
              <p className="navigation-empty">导入课件后，在这里按名称查找并继续阅读。</p>
            )}
          </div>
        ) : (
          <div className="resource-list">
            {state?.sources
              .filter(
                (s) => s.kind !== 'pdf' && s.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              )
              .map((s) => (
                <button
                  className="resource-card"
                  title={s.title}
                  key={s.id}
                  onClick={() => onAction('video', s.id)}
                >
                  <span className="resource-format video">
                    <Video size={17} />
                  </span>
                  <span>
                    <strong>{s.title}</strong>
                    <small>
                      {s.kind === 'local-video' ? '本地视频' : s.kind === 'bilibili' ? 'B站课程' : '在线课程'}
                    </small>
                  </span>
                </button>
              ))}
            {!state?.sources.length && <p className="navigation-empty">打开课程后，会自动保留学习记录。</p>}
          </div>
        )}
      </div>
      <div className="navigation-tools"><button aria-label="资料与备份管理" onClick={()=>onAction('manage')}><FolderOpen size={15}/>资料与备份管理</button>
        <button className="recognition-launch" onClick={() => onAction('learning')}>
          <Sparkles size={15} />
          识别与全库检索
        </button>
        {tab === 'notes' && (
          <>
            <div className="knowledge-sidebar-status">
              索引 {state?.knowledge?.files.toLocaleString() || 0} 篇 ·{' '}
              {state?.knowledge?.phase === 'scanning' ? '后台扫描中' : '全文可检索'}
            </div>
            <button aria-label="打开笔记存储目录" onClick={() => onAction('open-folder')}>
              <FolderOpen size={15} />
              知识库目录
            </button>
            <button className="vault-button" title={state?.vaultPath} onClick={() => onAction('vault')}>
              <FolderOpen size={15} />
              切换知识库
            </button>
            <small title={state?.vaultPath}>{state?.vaultPath}</small>
          </>
        )}
      </div>
    </aside>
  );
}
function NavigationNode({ node, style, dragHandle }: NodeRendererProps<NoteFile>) {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={'file-node ' + (node.isSelected ? 'selected' : '')}
      onClick={() => {
        if (node.isInternal) node.toggle();
        else {
          node.select();
          node.activate();
        }
      }}
    >
      {node.isInternal ? (
        <>
          <ChevronRight size={12} style={{ transform: node.isOpen ? 'rotate(90deg)' : undefined }} />
          <Folder size={14} />
        </>
      ) : (
        <FileText size={14} />
      )}
      <span title={node.data.path}>{node.data.name.replace(/\.md$/i, '')}</span>
    </div>
  );
}
