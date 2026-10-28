import { useEffect, useMemo, useState } from 'react';
import { FileText, History, RotateCcw, Trash2 } from 'lucide-react';
import type { NoteBackup } from '../../shared/library';
export function BackupBrowser({
  rows,
  query,
  initial,
  onRestored,
  run,
  busy,
}: {
  rows: NoteBackup[];
  query: string;
  initial?: string;
  onRestored: (path: string) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, NoteBackup[]>();
    for (const row of rows) {
      const key = row.path || '';
      map.set(key, [...(map.get(key) || []), row]);
    }
    return [...map]
      .map(([path, versions]) => ({
        path,
        versions: versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  }, [rows]);
  const [active, setActive] = useState(initial || ''),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<{ id: string; content: string } | null>(null);
  const visible = groups.filter(
    (g) =>
      !query ||
      g.path.toLowerCase().includes(query.toLowerCase()) ||
      (!g.path && '旧版待确认归属'.includes(query)),
  );
  const group = visible.find((g) => g.path === active) || visible[0];
  useEffect(() => {
    setSelected([]);
    setPreview(null);
  }, [group?.path]);
  const restore = (row: NoteBackup) => {
    const target =
      row.path ||
      window.prompt('此旧版备份没有原路径。请确认要恢复到哪个 Markdown 相对路径：', '恢复的笔记.md');
    if (!target || !window.confirm(`仅将“${target}”恢复到这个版本？恢复前会备份当前内容，其他笔记不受影响。`))
      return;
    void run(async () => {
      let version: string | null = null;
      try {
        version = (await window.studyMate.readNote(target)).version;
      } catch (e) {
        if (!/不存在|NOT_FOUND|ENOENT/.test((e as Error).message)) throw e;
      }
      await window.studyMate.library({ action: 'restore', id: row.id, path: target, version });
      onRestored(target);
      setPreview(null);
    });
  };
  return (
    <div className="backup-browser">
      <nav aria-label="按笔记选择备份">
        <h3>笔记 · {visible.length}</h3>
        {visible.map((g) => (
          <button
            key={g.path || 'legacy'}
            className={group?.path === g.path ? 'selected' : ''}
            aria-pressed={group?.path === g.path}
            title={g.path || '旧版备份 · 待确认归属'}
            onClick={() => setActive(g.path)}
          >
            <FileText size={16} />
            <span>
              <b>{g.path.split('/').pop() || '旧版 · 待确认归属'}</b>
              <small>
                {g.path.includes('/') ? g.path.slice(0, g.path.lastIndexOf('/')) : '根目录'} ·{' '}
                {g.versions.length} 个版本
              </small>
            </span>
          </button>
        ))}
        {!visible.length && <p className="library-empty">没有匹配的备份笔记。</p>}
      </nav>
      <section className="backup-versions" aria-label="当前笔记的备份版本">
        {group && (
          <>
            <header>
              <div>
                <h3>{group.path || '旧版备份 · 需要确认目标'}</h3>
                <p>仅恢复这一篇笔记的指定版本，不会恢复整个知识库。</p>
              </div>
              <button
                className="library-danger"
                disabled={!selected.length || busy}
                onClick={() => {
                  if (window.confirm(`清理这篇笔记已选的 ${selected.length} 个备份版本？当前笔记保留。`))
                    void run(async () => {
                      await window.studyMate.library({ action: 'clean-backups', ids: selected });
                      setSelected([]);
                      setPreview(null);
                    });
                }}
              >
                <Trash2 size={14} />
                清理已选备份 · {selected.length}
              </button>
            </header>
            {group.versions.map((row, i) => (
              <article className="backup-version" key={row.id}>
                <div className="library-row">
                  <input
                    type="checkbox"
                    aria-label={'选择备份 ' + row.id}
                    checked={selected.includes(row.id)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, row.id] : s.filter((id) => id !== row.id),
                      )
                    }
                  />
                  <button
                    className="library-row-title"
                    aria-label={'预览备份 ' + row.id}
                    onClick={() =>
                      void run(async () =>
                        setPreview({
                          id: row.id,
                          content:
                            (await window.studyMate.library({ action: 'backup-content', id: row.id }))
                              .content || '',
                        }),
                      )
                    }
                  >
                    <strong>
                      <History size={13} /> {new Date(row.createdAt).toLocaleString()}{' '}
                      {i === 0 && <em>最近版本</em>}
                    </strong>
                    <small>
                      {row.reason} · {(row.bytes / 1024).toFixed(1)} KB · {row.version.slice(0, 10)}
                    </small>
                  </button>
                  <button aria-label={'恢复备份 ' + row.id} disabled={busy} onClick={() => restore(row)}>
                    <RotateCcw size={15} />
                    恢复此版本
                  </button>
                </div>
                {preview?.id === row.id && <pre className="backup-preview">{preview.content}</pre>}
              </article>
            ))}
          </>
        )}
        {!rows.length && <p className="library-empty">尚无备份。修改已有笔记前会自动保存原版本。</p>}
      </section>
    </div>
  );
}
