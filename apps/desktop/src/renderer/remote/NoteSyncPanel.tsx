import { useEffect, useState } from 'react';
import type { NoteSyncControl, NoteSyncState } from '../../shared/note-sync';

export function NoteSyncPanel() {
  const [state, setState] = useState<NoteSyncState>();
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(input: NoteSyncControl) {
    setBusy(true);
    setError('');
    try { setState(await window.studyMate.noteSync(input)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (busy) return;
    let active = true;
    const load = () => void window.studyMate.noteSync({ action: 'state' })
      .then((next) => { if (active) setState(next); })
      .catch((e: Error) => { if (active) setError(e.message); });
    load();
    const timer = setInterval(load, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [busy]);
  const shown = state?.notes.filter((note) => note.path.toLowerCase().includes(filter.toLowerCase()));
  return <details>
    <summary>同步笔记到平板{state ? `（已选 ${state.notes.filter((note) => note.selected).length} 篇）` : ''}</summary>
    <p>勾选要随身阅读的笔记。已配对平板同网时自动下载，连接 Google Drive 后也可异地更新。</p>
    <input aria-label="筛选要同步的笔记" placeholder="按名称筛选笔记" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <div style={{ maxHeight: '14rem', overflow: 'auto', margin: '8px 0' }}>
      {shown?.map((note) => <label className="remote-device" key={note.path}>
        <input type="checkbox" checked={note.selected} disabled={busy} onChange={(event) =>
          void run({ action: 'select', path: note.path, enabled: event.target.checked })} />
        <span>{note.path}</span>
      </label>)}
      {shown?.length === 0 && <p>没有匹配的笔记</p>}
    </div>
    <div className="remote-actions">
      <button disabled={busy} onClick={() => void run({ action: 'refresh' })}>立即同步</button>
      {state?.account
        ? <><span>{state.account} · {state.uploaded > 0 && state.uploaded === state.revision ? 'Drive 已更新' : '等待上传'}</span>
          <button disabled={busy} onClick={() => void run({ action: 'drive-disconnect' })}>停止上传</button></>
        : <label>连接 Google Drive
          <input type="file" accept=".json,application/json" disabled={busy} onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file && file.size <= 16384) {
              try { await run({ action: 'drive-connect', credential: await file.text() }); }
              catch { setError('无法读取桌面 OAuth 配置。'); }
            } else if (file) setError('请选择 Google Cloud 下载的桌面 OAuth JSON。');
          }} />
        </label>}
    </div>
    {!state?.account && <p>首次连接请选择 Google Cloud 项目下载的桌面 OAuth JSON，然后在浏览器授权。</p>}
    {(error || state?.error) && <p role="alert" className="remote-error">{error || state?.error}</p>}
  </details>;
}
