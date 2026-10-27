import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplayMath } from '../apps/desktop/src/renderer/notes/math-source';
import { compileNote } from '../apps/desktop/src/renderer/notes/markdown';
test('Obsidian multiline delimiters do not swallow subsequent headings and callouts', async () => {
  const input = String.raw`$$K=2a+b(\lambda_1+\lambda_2)
=\frac{4ac-b^2}{c}\neq0.$$
新变量的雅可比
$$\frac{\partial(u,v)}{\partial(x,y)}
=\begin{vmatrix}1&\lambda_1\\1&\lambda_2\end{vmatrix}
=\lambda_2-\lambda_1\neq0,$$

> [!warning] 保持适用条件
> 正文仍需正常排版。

### 后续例题

正常内容。`;
  const compiled = await compileNote(input),
    json = JSON.stringify(compiled.blocks);
  assert.equal(compiled.warnings, 0);
  assert.match(json, /note-callout/);
  assert.ok(compiled.headings.some((h) => h.text === '后续例题'));
  assert.equal((json.match(/"className":\["katex"/g) || []).length, 2);
  assert.equal(normalizeDisplayMath(normalizeDisplayMath(input)), normalizeDisplayMath(input));
});
test('Display cases inside quotes/lists render while code fences and inline code stay literal', async () => {
  const input =
    '> $$\\begin{cases}\n> x=1\\\\y=2\n> \\end{cases}$$\n\n- 结果\n\n  $$x=1$$\n\n```latex\n$$a=1\n=2$$\n```\n\n`$$源码$$`\n';
  const normal = normalizeDisplayMath(input);
  assert.ok(normal.includes('```latex\n$$a=1\n=2$$\n```'));
  assert.ok(normal.includes('`$$源码$$`'));
  const note = await compileNote(input);
  assert.equal(note.warnings, 0);
  assert.match(JSON.stringify(note.blocks), /language-latex/);
});
test('Control engineering multiline cases and one-line display math have distinct blocks', async () => {
  const input = String.raw`$$\Phi(s)=\frac{0.09}{s^2+s+0.09}$$

$$\begin{cases}
2\xi\omega_n=1\\
\omega_n^2=0.09
\end{cases}$$

## 动态指标

继续阅读 $t_s=3T_1$。`;
  const note = await compileNote(input);
  assert.equal(note.warnings, 0);
  assert.ok(note.headings.some((h) => h.text === '动态指标'));
  assert.ok(note.blocks.length >= 4);
});
