import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDesk,
  showNote,
  moveTab,
  removeTab,
  isDirty,
} from '../apps/desktop/src/renderer/workspace/note-desk';
import type { NoteDocument } from '../apps/desktop/src/shared/contracts';
const doc = (path: string) =>
  ({ path, content: '# ' + path, version: 'v1', modifiedAt: 'now' }) as NoteDocument;
test('Independent note tabs preserve drafts across navigation and pane moves', () => {
  let d = showNote(emptyDesk(), doc('A.md'), 'main');
  d.sessions['A.md'].content += ' draft';
  d = showNote(d, doc('B.md'), 'main');
  assert.deepEqual(d.main.tabs, ['A.md', 'B.md']);
  d = showNote(d, doc('A.md'), 'main');
  assert.ok(isDirty(d.sessions['A.md']));
  assert.equal(d.main.history.length, 3);
  d = moveTab(d, 'A.md', 'main', 'side');
  assert.deepEqual(d.main.tabs, ['B.md']);
  assert.equal(d.side.active, 'A.md');
  assert.ok(isDirty(d.sessions['A.md']));
  d = showNote(d, doc('A.md'), 'main');
  d = removeTab(d, 'side', 'A.md');
  assert.ok(d.sessions['A.md']);
  d = removeTab(d, 'main', 'A.md');
  assert.equal(d.sessions['A.md'], undefined);
});
test('Back navigation branches forward history and asynchronous old reads do not steal focus', () => {
  let d = showNote(emptyDesk(), doc('A'), 'main');
  d = showNote(d, doc('B'), 'main', 'heading');
  d = { ...d, main: { ...d.main, cursor: 0 } };
  d = showNote(d, doc('C'), 'main');
  assert.deepEqual(
    d.main.history.map((l) => l.path),
    ['A', 'C'],
  );
  d = showNote(d, doc('late'), 'main', '', true, 'preview', false);
  assert.equal(d.main.active, 'C');
  assert.equal(d.main.history.length, 2);
  for (let i = 0; i < 120; i++) d = showNote(d, doc('n' + i), 'main');
  assert.equal(d.main.history.length, 100);
  assert.equal(d.main.cursor, 99);
});
