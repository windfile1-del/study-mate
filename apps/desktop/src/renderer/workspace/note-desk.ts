import type { NoteDocument } from '../../shared/contracts';
export type Pane = 'main' | 'side';
export type NoteView = 'live' | 'edit' | 'preview';
export interface NoteSession {
  document: NoteDocument;
  content: string;
  initialView: NoteView;
}
export interface Location {
  path: string;
  anchor: string;
}
export interface PaneState {
  tabs: string[];
  active: string | null;
  history: Location[];
  cursor: number;
  views: Record<string, NoteView>;
}
export interface Desk {
  sessions: Record<string, NoteSession>;
  main: PaneState;
  side: PaneState;
  focused: Pane;
}
const emptyPane = (): PaneState => ({ tabs: [], active: null, history: [], cursor: -1, views: {} });
export const emptyDesk = (): Desk => ({
  sessions: {},
  main: emptyPane(),
  side: emptyPane(),
  focused: 'main',
});
export const isDirty = (session: NoteSession) => session.content !== session.document.content;
export function showNote(
  desk: Desk,
  document: NoteDocument,
  pane: Pane,
  anchor = '',
  record = true,
  view: NoteView = 'preview',
  activate = true,
): Desk {
  const path = document.path,
    old = desk[pane];
  const location = { path, anchor };
  let history = old.history,
    cursor = old.cursor;
  if (activate && record && (history[cursor]?.path !== path || history[cursor]?.anchor !== anchor)) {
    history = [...history.slice(0, cursor + 1), location].slice(-100);
    cursor = history.length - 1;
  }
  return {
    ...desk,
    sessions: {
      ...desk.sessions,
      [path]: desk.sessions[path] || { document, content: document.content, initialView: view },
    },
    [pane]: {
      ...old,
      tabs: old.tabs.includes(path) ? old.tabs : [...old.tabs, path],
      active: activate ? path : old.active,
      history,
      cursor,
    },
    focused: activate ? pane : desk.focused,
  };
}
export function removeTab(desk: Desk, pane: Pane, path: string): Desk {
  const old = desk[pane],
    at = old.tabs.indexOf(path),
    tabs = old.tabs.filter((item) => item !== path);
  const active = old.active === path ? tabs[Math.max(0, at - 1)] || null : old.active;
  const next: Desk = { ...desk, [pane]: { ...old, tabs, active } };
  if (!next.main.tabs.includes(path) && !next.side.tabs.includes(path)) {
    next.sessions = { ...next.sessions };
    delete next.sessions[path];
  }
  return next;
}
export function moveTab(desk: Desk, path: string, from: Pane, to: Pane): Desk {
  const session = desk.sessions[path];
  if (!session || from === to) return desk;
  const added = showNote(desk, session.document, to, '', true);
  return { ...removeTab(added, from, path), focused: to };
}
