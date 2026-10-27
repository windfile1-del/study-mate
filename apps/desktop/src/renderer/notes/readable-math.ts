import type { Root, Parents, RootContent } from 'mdast';
const chinese = /[\u3400-\u9fff]/;
// Operate on parsed math only. Preserve the Markdown file and fenced/source code.
export function readableCjkMath(value: string, inline: boolean): string {
  if (!chinese.test(value) || !/\\d?frac\b/.test(value)) return value;
  const closing = (start: number) => {
    let level = 0;
    for (let i = start; i < value.length; i++) {
      if (value[i] === '\\') {
        i++;
        continue;
      }
      if (value[i] === '{') level++;
      else if (value[i] === '}' && --level === 0) return i;
    }
    return -1;
  };
  const inserts = new Set<number>();
  for (const match of value.matchAll(/\\d?frac\s*\{/g)) {
    const a = match.index! + match[0].length - 1,
      b = closing(a);
    if (b < 0) continue;
    let c = b + 1;
    while (/\s/.test(value[c] || '!')) c++;
    if (value[c] !== '{') continue;
    const d = closing(c);
    if (d < 0) continue;
    if (chinese.test(value.slice(a + 1, b)) || chinese.test(value.slice(c + 1, d))) {
      inserts.add(a + 1);
      inserts.add(c + 1);
    }
  }
  for (const at of [...inserts].sort((a, b) => b - a))
    value = value.slice(0, at) + '\\rule[-0.25em]{0pt}{1.2em} ' + value.slice(at);
  return inline && !/\\(?:display|text|script|scriptscript)style\b/.test(value)
    ? '\\displaystyle ' + value
    : value;
}
export function remarkReadableMath() {
  return (tree: Root) => {
    const visit = (parent: Parents) => {
      for (const node of parent.children as RootContent[]) {
        if (node.type === 'inlineMath' || node.type === 'math') {
          const inline = node.type === 'inlineMath';
          node.value = readableCjkMath(node.value, inline);
          const patch = (children: any[]) => {
            for (const child of children) {
              if (child.type === 'text') child.value = readableCjkMath(child.value, inline);
              else if (child.children) patch(child.children);
            }
          };
          if (node.data?.hChildren) patch(node.data.hChildren);
        } else if ('children' in node) visit(node as Parents);
      }
    };
    visit(tree);
  };
}
