import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers';
import { KnowledgeDb, chunkNote, noteLinks } from '../apps/desktop/src/core/knowledge-db';
import { AudioTimeline } from '../apps/desktop/src/core/audio-timeline';

test('Obsidian YAML aliases, empty note names and Greek math terms remain searchable', async (t) => {
  const root = await workspace(t),
    vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  await fs.writeFile(
    path.join(vault, '目标.md'),
    '---\naliases:\n  - 阻尼别名\n  - "Alpha, Beta"\n---\n# ζ ωₙ 二阶系统',
  );
  await fs.writeFile(path.join(vault, '引用.md'), '[[阻尼别名]]\n[[Alpha, Beta]]');
  await fs.writeFile(path.join(vault, '空白试题.md'), '');
  const db = new KnowledgeDb(vault, 'scope', path.join(root, 'index.sqlite'));
  t.after(() => db.close());
  await db.scan(() => {});
  assert.equal(db.resolve('引用.md', '阻尼别名', true).path, '目标.md');
  assert.equal(db.backlinks('目标.md').length, 2);
  assert.equal(db.keyword('ζ')[0].path, '目标.md');
  assert.equal(db.keyword('空白试题')[0].path, '空白试题.md');
});
test('Audio epochs map 2x playback to source seconds and never bridge seeks, pauses or source changes', () => {
  const timeline = new AudioTimeline(),
    base = { sourceId: 'one', visitId: 'visit', rate: 2, paused: false };
  timeline.push({ ...base, wall: 1000, time: 10 });
  timeline.push({ ...base, wall: 1200, time: 10.4 });
  timeline.push({ ...base, wall: 1400, time: 10.8 });
  const slices = timeline.slice(new Float32Array(6400).fill(0.1), 1000);
  assert.equal(slices.length, 2);
  assert.equal(slices[0].mediaStart, 10);
  assert.equal(slices[1].mediaStart, 10.4);
  timeline.push({ ...base, wall: 1600, time: 90 });
  timeline.push({ ...base, wall: 1800, time: 90.4 });
  assert.equal(timeline.spans.at(-1)!.epoch, 1);
  assert.equal(
    timeline.spans.some((s) => s.from === 1400),
    false,
  );
  timeline.push({ ...base, wall: 2000, time: 90.4, paused: true });
  timeline.push({ ...base, wall: 2200, time: 90.4 });
  timeline.push({ ...base, wall: 2400, time: 90.8 });
  assert.ok(timeline.spans.at(-1)!.epoch > 1);
  timeline.push({ ...base, wall: 2600, time: 91.2, visitId: 'new' });
  assert.equal(
    timeline.spans.some((s) => s.from === 2400),
    false,
  );
});
test('Persistent index searches beyond 5000 notes and 64KB, updates/removes incrementally, resolves backlinks and survives restart', async (t) => {
  const root = await workspace(t),
    vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  for (let i = 0; i < 6001; i += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 6001 - i) }, (_, j) =>
        fs.writeFile(path.join(vault, `笔记-${i + j}.md`), `# 条目 ${i + j}\n普通内容`),
      ),
    );
  await fs.writeFile(path.join(vault, '笔记-6000.md'), 'a'.repeat(70000) + '\n深处的拉普拉斯变换唯一证据');
  await fs.writeFile(path.join(vault, '目标.md'), '---\naliases: [动力学别名]\n---\n# 二阶响应\n超调与阻尼');
  await fs.writeFile(
    path.join(vault, '引用.md'),
    '[[动力学别名]]\n[关联](目标.md)\n```md\n[[不要计入]]\n```',
  );
  const file = path.join(root, 'search.sqlite'),
    db = new KnowledgeDb(vault, 'scope', file);
  let counts = await db.scan(() => {});
  assert.equal(counts.files, 6003);
  assert.equal(db.keyword('拉普拉斯变换唯一证据')[0].path, '笔记-6000.md');
  assert.equal(db.backlinks('目标.md').length, 2);
  await fs.writeFile(path.join(vault, '目标.md'), '# 全新更新证据');
  await db.update('目标.md');
  assert.equal(db.keyword('全新更新证据')[0].path, '目标.md');
  await fs.unlink(path.join(vault, '引用.md'));
  await db.update('引用.md');
  assert.equal(db.backlinks('目标.md').length, 0);
  db.close();
  const restored = new KnowledgeDb(vault, 'scope', file);
  t.after(() => restored.close());
  assert.equal(restored.keyword('全新更新证据')[0].path, '目标.md');
  assert.equal(restored.counts().files, 6002);
});
test('Index chunks bound multilingual embedding input, retain original line positions and exclude code links', () => {
  const text = '# 标题\n' + '中'.repeat(1700) + '\n最后一行';
  const chunks = chunkNote(text);
  assert.ok(chunks.every((c) => c.text.length <= 401));
  assert.equal(chunks.filter((c) => c.lineStart === 2).length, 5);
  assert.deepEqual(noteLinks('[[笔记#标题|别名]]\n[正文](dir/笔记.md)\n`[[不计入]]`\n![图片](a.png)'), [
    { target: '笔记', line: 1 },
    { target: 'dir/笔记.md', line: 2 },
  ]);
});
