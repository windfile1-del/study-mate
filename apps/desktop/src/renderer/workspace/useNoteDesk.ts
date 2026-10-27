import { useEffect, useRef, useState } from 'react';
import {
  emptyDesk,
  isDirty,
  showNote,
  removeTab,
  moveTab,
  type Desk,
  type Pane,
  type NoteView,
} from './note-desk';
const api = window.studyMate;
export function useNoteDesk(vaultId: string | undefined, onError: (message: string) => void) {
  const [desk, setDesk] = useState(emptyDesk),
    current = useRef(desk);
  const [saving, setSaving] = useState<string[]>([]),
    [loading, setLoading] = useState(false);
  const savingPaths = useRef(new Set<string>());
  const [closing, setClosing] = useState<{ pane: Pane; path: string } | null>(null);
  const epoch = useRef(vaultId),
    generations = useRef({ main: 0, side: 0 });
  const positions = useRef(new Map<string, number>());
  const update = (run: (old: Desk) => Desk) => {
    const next = run(current.current);
    current.current = next;
    setDesk(next);
  };
  useEffect(() => {
    if (epoch.current !== vaultId) {
      epoch.current = vaultId;
      generations.current.main++;
      generations.current.side++;
      positions.current.clear();
      update(emptyDesk);
      setClosing(null);
    }
  }, [vaultId]);
  const open = async (path: string, anchor = '', pane: Pane = current.current.focused, record = true) => {
    const generation = ++generations.current[pane],
      vault = epoch.current;
    setLoading(true);
    try {
      const document = current.current.sessions[path]?.document || (await api.readNote(path));
      if (vault !== epoch.current) return false;
      update((old) =>
        showNote(old, document, pane, anchor, record, 'preview', generations.current[pane] === generation),
      );
      onError('');
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : '无法读取笔记');
      return false;
    } finally {
      if (generation === generations.current[pane]) setLoading(false);
    }
  };
  const save = async (path: string): Promise<boolean> => {
    const session = current.current.sessions[path],
      vault = epoch.current;
    if (!session || !isDirty(session)) return true;
    if (savingPaths.current.has(path)) return false;
    savingPaths.current.add(path);
    const snapshot = session.content;
    setSaving((old) => [...old, path]);
    onError('');
    try {
      const document = await api.saveNote({
        path,
        content: snapshot,
        expectedVersion: session.document.version,
        operationId: crypto.randomUUID(),
      });
      if (vault !== epoch.current) return false;
      update((old) => {
        const live = old.sessions[path];
        if (!live) return old;
        return {
          ...old,
          sessions: {
            ...old.sessions,
            [path]: {
              ...live,
              document,
              content: live.content === snapshot ? document.content : live.content,
            },
          },
        };
      });
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : '保存失败');
      return false;
    } finally {
      savingPaths.current.delete(path);
      setSaving((old) => old.filter((item) => item !== path));
    }
  };
  const saveAll = async () => {
    for (const path of Object.keys(current.current.sessions)) if (!(await save(path))) return false;
    return !Object.values(current.current.sessions).some(isDirty);
  };
  const create = async () => {
    try {
      const stamp = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .format(new Date())
        .replace(/[- :]/g, '');
      const document = await api.saveNote({
        path: '学习笔记-' + stamp + '.md',
        content: '# 学习笔记\n\n',
        expectedVersion: null,
        operationId: crypto.randomUUID(),
      });
      update((old) => showNote(old, document, 'main', '', true, 'live'));
      onError('');
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : '创建失败');
      return false;
    }
  };
  const reload = async (path: string) => {
    const session = current.current.sessions[path],
      vault = epoch.current;
    if (!session) return;
    if (isDirty(session)) {
      onError('当前有未保存的内容，请先保存或另存副本。');
      return;
    }
    try {
      const document = await api.readNote(path);
      if (vault !== epoch.current) return;
      if (current.current.sessions[path]?.content !== session.content) {
        onError('读取期间笔记有了新修改，已保留草稿。');
        return;
      }
      update((old) =>
        old.sessions[path]
          ? {
              ...old,
              sessions: {
                ...old.sessions,
                [path]: { ...old.sessions[path], document, content: document.content },
              },
            }
          : old,
      );
      onError('');
    } catch (error) {
      onError(error instanceof Error ? error.message : '刷新失败');
    }
  };
  const copy = async (path: string, pane: Pane) => {
    const session = current.current.sessions[path];
    if (!session) return;
    try {
      const document = await api.saveNote({
        path: path.replace(/\.md$/i, '') + '-副本-' + crypto.randomUUID().slice(0, 8) + '.md',
        content: session.content,
        expectedVersion: null,
        operationId: crypto.randomUUID(),
      });
      const original = await api.readNote(path).catch(() => null);
      update((old) => {
        let next = old;
        if (original && old.sessions[path]?.content === session.content)
          next = {
            ...old,
            sessions: {
              ...old.sessions,
              [path]: { ...old.sessions[path], document: original, content: original.content },
            },
          };
        return showNote(next, document, pane, '', true, old[pane].views[path] || session.initialView);
      });
      onError('');
    } catch (error) {
      onError(error instanceof Error ? error.message : '另存失败');
    }
  };
  const close = (pane: Pane, path: string, discard = false) => {
    const session = current.current.sessions[path],
      other: Pane = pane === 'main' ? 'side' : 'main';
    if (!discard && session && isDirty(session) && !current.current[other].tabs.includes(path)) {
      setClosing({ pane, path });
      return;
    }
    update((old) => removeTab(old, pane, path));
    setClosing(null);
  };
  const history = async (pane: Pane, delta: number) => {
    const old = current.current[pane],
      cursor = old.cursor + delta,
      location = old.history[cursor];
    if (!location) return false;
    if (!(await open(location.path, location.anchor, pane, false))) return false;
    update((desk) => ({ ...desk, [pane]: { ...desk[pane], cursor } }));
    return true;
  };
  const active = (pane: Pane) => {
    const path = desk[pane].active;
    return path ? desk.sessions[path] || null : null;
  };
  return {
    desk,
    active,
    saving,
    loading,
    closing,
    setClosing,
    open,
    save,
    saveAll,
    create,
    reload,
    copy,
    close,
    history,
    dirty: Object.values(desk.sessions).some(isDirty),
    focus: (pane: Pane) => {
      if (current.current.focused !== pane) update((old) => ({ ...old, focused: pane }));
    },
    move: (path: string, from: Pane, to: Pane) => {
      if (!positions.current.has(to + ':' + path))
        positions.current.set(to + ':' + path, positions.current.get(from + ':' + path) || 0);
      update((old) => moveTab(old, path, from, to));
    },
    edit: (path: string, content: string) =>
      update((old) => ({
        ...old,
        sessions: { ...old.sessions, [path]: { ...old.sessions[path], content } },
      })),
    view: (pane: Pane, path: string, view: NoteView) =>
      update((old) => ({ ...old, [pane]: { ...old[pane], views: { ...old[pane].views, [path]: view } } })),
    position: (pane: Pane, path: string) => positions.current.get(pane + ':' + path) || 0,
    remember: (pane: Pane, path: string, offset: number) => positions.current.set(pane + ':' + path, offset),
  };
}
export type NoteDesk = ReturnType<typeof useNoteDesk>;
