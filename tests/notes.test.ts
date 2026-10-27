import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultService } from '../apps/desktop/src/core/vault';
import { compileNote } from '../apps/desktop/src/renderer/notes/markdown';
import { workspace } from './helpers';
import { readableCjkMath } from '../apps/desktop/src/renderer/notes/readable-math';

test('中文分子分母保持正常字号和支撑高度，源码与普通公式不受影响', async () => {
  const formula = String.raw`\frac{所有极点长度的乘积}{所有零点长度的乘积}`;
  const result = await compileNote('$' + formula + '$');
  const json = JSON.stringify(result.blocks);
  assert.match(json, /displaystyle/);
  assert.match(json, /rule/);
  assert.match(json, /cjk-fraction/);
  assert.equal(result.warnings, 0);
  assert.doesNotMatch(json, /#cc0000/);
  assert.equal(readableCjkMath(String.raw`\frac{1}{s+1}`, true), String.raw`\frac{1}{s+1}`);
  assert.match(formula, /^\\frac/);
});

test('公式、Mermaid、双链、图片、Callout与属性生成渲染结构，代码内不改写', async () => {
  const source =
    '---\ntags: [控制]\n---\n# 根轨迹\n\n$G(s)=\\frac{1}{s+1}$\n\n$$\n\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}\n$$\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n[[其他笔记#小节|跳转]] ![[示意.svg|620]] ==重点== %%隐藏注释%%\n\n> [!tip]- 提示\n> 保持原文\n\n`[[不能改写]] $x$`\n';
  const result = await compileNote(source),
    json = JSON.stringify(result.blocks);
  assert.match(json, /katex/);
  assert.match(json, /language-mermaid/);
  assert.match(json, /dataWiki/);
  assert.match(json, /note-callout/);
  assert.match(json, /summary/);
  assert.match(json, /mark/);
  assert.match(json, /\[\[不能改写\]\] \$x\$/);
  assert.doesNotMatch(json, /隐藏注释/);
  assert.equal(result.properties, 'tags: [控制]');
  assert.equal(result.headings[0].id, '根轨迹');
});
test('HTML先净化后生成KaTeX，脚本事件移除，坏公式不让整篇失败', async () => {
  const result = await compileNote(
    '<script>window.injected=1</script><img src="x" onerror="window.injected=2"><a href="javascript:alert(1)">x</a>\n\n$$\\badCommand{x}$$\n\n## 后续内容\n\n正常正文',
  );
  const json = JSON.stringify(result.blocks);
  assert.doesNotMatch(json, /window.injected|javascript:|onError|onerror|"tagName":"script"/);
  assert.match(json, /后续内容/);
});
test('双链解析相对路径、唯一附件与邻近文件，拒绝越界', async (t) => {
  const root = await workspace(t),
    vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  await fs.mkdir(path.join(vault.root, '课程/images'), { recursive: true });
  await fs.mkdir(path.join(vault.root, '其他'));
  await fs.writeFile(path.join(vault.root, '课程/首页.md'), '# 首页');
  await fs.writeFile(path.join(vault.root, '其他/目标.md'), '# 小节');
  await fs.writeFile(path.join(vault.root, '课程/images/示意.svg'), '<svg/>');
  assert.deepEqual(await vault.resolveLink('课程/首页.md', '目标#小节', true), {
    path: '其他/目标.md',
    anchor: '小节',
  });
  assert.equal(
    (await vault.resolveLink('课程/首页.md', 'images/示意.svg', false)).path,
    '课程/images/示意.svg',
  );
  assert.equal((await vault.resolveLink('课程/首页.md', '示意.svg', true)).path, '课程/images/示意.svg');
  await assert.rejects(vault.resolveLink('课程/首页.md', '../../outside.md', false), { code: 'PATH_DENIED' });
  await assert.rejects(vault.resolveLink('课程/首页.md', 'file:///C:/secret.md', true), {
    code: 'PATH_DENIED',
  });
  await fs.writeFile(path.join(vault.root, '课程/目标.md'), '邻近目标');
  assert.equal((await vault.resolveLink('课程/首页.md', '目标', true)).path, '课程/目标.md');
});
test('大列表分块并重用目录扫描，写入使缓存失效', async (t) => {
  const root = await workspace(t),
    vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  await vault.write({ path: '1.md', content: '# 一', expectedVersion: null, operationId: 'one' });
  const first = await vault.list();
  assert.equal(await vault.list(), first);
  await vault.write({ path: '2.md', content: '# 二', expectedVersion: null, operationId: 'two' });
  assert.equal((await vault.list()).length, 2);
  const note = await compileNote(Array.from({ length: 200 }, (_, i) => '- 条目 ' + i).join('\n'));
  assert.ok(note.blocks.length >= 10);
});
test('Callout标题中的加粗、块引用和脚注锚点保留', async () => {
  const note = await compileNote(
    '> [!important] **加粗标题**\n> 正文\n\n定义内容。 ^definition\n\n脚注[^a]。\n\n[^a]: 补充说明',
  );
  const json = JSON.stringify(note.blocks);
  assert.match(json, /加粗标题/);
  assert.match(json, /\"tagName\":\"strong\"/);
  assert.ok(note.anchors['user-content-obs-block-definition'] !== undefined);
  assert.ok(Object.keys(note.anchors).some((key) => key.includes('fn-a')));
});
