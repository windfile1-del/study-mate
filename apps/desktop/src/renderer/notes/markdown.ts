import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';
import rehypeKatex from 'rehype-katex';
import type { Root as MdRoot, RootContent, PhrasingContent, Parents } from 'mdast';
import type { Root, Element, RootContent as HtmlBlock } from 'hast';
import { headingKey } from './heading';
import { remarkReadableMath } from './readable-math';
import { normalizeDisplayMath } from './math-source';

export interface Heading {
  id: string;
  text: string;
  depth: number;
  block: number;
}
export interface CompiledNote {
  blocks: HtmlBlock[];
  headings: Heading[];
  anchors: Record<string, number>;
  properties: string;
  warnings: number;
  milliseconds: number;
  bytes: number;
}
const imageExtension = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:#.*)?$/i;
const textOf = (node: { value?: string; children?: unknown[] }): string =>
  node.value ?? node.children?.map((child) => textOf(child as typeof node)).join('') ?? '';

function obsidian() {
  return (tree: MdRoot, file: { data: Record<string, unknown> }) => {
    const yaml = tree.children.find((node) => node.type === 'yaml');
    file.data.properties = yaml && 'value' in yaml ? String(yaml.value) : '';
    tree.children = tree.children.filter((node) => node.type !== 'yaml');
    const visit = (parent: Parents) => {
      if (!('children' in parent)) return;
      parent.children = parent.children.flatMap((node, index): RootContent[] => {
        if (node.type === 'heading')
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, dataHeadingText: textOf(node) },
          };
        if (node.type === 'paragraph') {
          const last = node.children.at(-1);
          const marker = last?.type === 'text' ? /(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/.exec(last.value) : null;
          if (marker && last?.type === 'text') {
            last.value = last.value.slice(0, marker.index);
            const target = node.children.every((child) => child.type === 'text' && !child.value.trim())
              ? parent.children[index - 1]
              : node;
            if (target)
              target.data = {
                ...target.data,
                hProperties: { ...target.data?.hProperties, id: 'obs-block-' + marker[1] },
              };
            if (target !== node) return [];
          }
        }
        if (node.type === 'text') {
          const result: PhrasingContent[] = [];
          const regex = /!?\[\[([^\]\n]+)\]\]|==([^=\n]+)==|%%[\s\S]*?%%/g;
          let from = 0;
          for (const match of node.value.matchAll(regex)) {
            if (match.index! > from)
              result.push({ type: 'text', value: node.value.slice(from, match.index) });
            if (match[1]) {
              const [target, alias] = match[1].split('|');
              if (match[0].startsWith('!') && imageExtension.test(target)) {
                result.push({
                  type: 'image',
                  url: target,
                  alt: alias && !/^\d+(?:x\d+)?$/.test(alias) ? alias : target,
                  data: {
                    hProperties: {
                      dataWiki: 'true',
                      ...(alias && /^\d+(?:x\d+)?$/.test(alias)
                        ? { width: Number(alias.split('x')[0]) }
                        : {}),
                    },
                  },
                });
              } else
                result.push({
                  type: 'link',
                  url: target,
                  children: [{ type: 'text', value: alias || target.split('/').pop() || target }],
                  data: {
                    hProperties: {
                      dataWiki: 'true',
                      ...(match[0].startsWith('!') ? { dataEmbed: 'true' } : {}),
                    },
                  },
                });
            } else if (match[2])
              result.push({
                type: 'emphasis',
                children: [{ type: 'text', value: match[2] }],
                data: { hName: 'mark' },
              });
            from = match.index! + match[0].length;
          }
          if (from < node.value.length) result.push({ type: 'text', value: node.value.slice(from) });
          return result;
        }
        if ('children' in node && node.type !== 'link') visit(node as Parents);
        if (node.type === 'blockquote') {
          const first = node.children[0];
          const text = first?.type === 'paragraph' ? first.children[0] : undefined;
          const match = text?.type === 'text' ? /^\[!([a-z-]+)\]([+-])?[ \t]*/i.exec(text.value) : null;
          if (match && first?.type === 'paragraph' && text?.type === 'text') {
            text.value = text.value.slice(match[0].length);
            const title: PhrasingContent[] = [],
              body: PhrasingContent[] = [];
            let afterBreak = false;
            for (const child of first.children) {
              if (!afterBreak && child.type === 'text' && child.value.includes('\n')) {
                const at = child.value.indexOf('\n');
                if (at) title.push({ type: 'text', value: child.value.slice(0, at) });
                if (child.value.slice(at + 1)) body.push({ type: 'text', value: child.value.slice(at + 1) });
                afterBreak = true;
              } else (afterBreak ? body : title).push(child);
            }
            if (!title.some((child) => child.type !== 'text' || child.value.trim()))
              title.push({ type: 'text', value: match[1] });
            if (body.length) first.children = body;
            else node.children.shift();
            node.data = {
              hName: match[2] ? 'details' : 'aside',
              hProperties: {
                className: ['note-callout'],
                dataCallout: match[1].toLowerCase(),
                ...(match[2] === '+' ? { open: true } : {}),
              },
            };
            node.children.unshift({
              type: 'paragraph',
              children: title,
              data: { hName: match[2] ? 'summary' : 'div', hProperties: { className: ['callout-title'] } },
            });
          }
        }
        return [node as RootContent];
      }) as typeof parent.children;
    };
    visit(tree);
  };
}
const schema: Schema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href || []), 'study-cite','study-video'] },
  tagNames: [...(defaultSchema.tagNames || []), 'mark', 'aside', 'summary', 'details'],
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code || []),
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    a: [...(defaultSchema.attributes?.a || []), 'dataWiki', 'dataEmbed'],
    img: [...(defaultSchema.attributes?.img || []), 'dataWiki', 'width', 'height'],
    aside: ['className', 'dataCallout'],
    details: ['className', 'dataCallout', 'open'],
    div: [...(defaultSchema.attributes?.div || []), 'className'],
    ...Object.fromEntries(
      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => [
        tag,
        [...(defaultSchema.attributes?.[tag] || []), 'dataHeadingText'],
      ]),
    ),
  },
};
export async function compileNote(source: string): Promise<CompiledNote> {
  const started = performance.now();
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: true })
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkReadableMath)
    .use(obsidian)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)
    .use(rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 10000, macros: {} });
  const file = { value: normalizeDisplayMath(source), data: {} as Record<string, unknown> };
  const tree = (await processor.run(processor.parse(file), file)) as Root;
  const headings: Heading[] = [],
    seen = new Map<string, number>();
  const anchors: Record<string, number> = {};
  const visit = (node: Root | Element, block: number) => {
    delete node.position;
    if (
      node.type === 'element' &&
      Array.isArray(node.properties.className) &&
      node.properties.className.includes('katex')
    ) {
      const source = textOf(node);
      if (/[\u3400-\u9fff]/.test(source) && /\\d?frac\b/.test(source))
        node.properties.className.push('cjk-fraction');
    }
    if (node.type === 'element' && typeof node.properties.id === 'string')
      anchors[node.properties.id] = block;
    if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
      const text =
          typeof node.properties.dataHeadingText === 'string'
            ? node.properties.dataHeadingText
            : textOf(node),
        base = headingKey(text) || 'section';
      const suffix = seen.get(base) || 0;
      seen.set(base, suffix + 1);
      const id = base + (suffix ? '-' + suffix : '');
      node.properties.id = id;
      anchors[id] = block;
      headings.push({ id, text, depth: Number(node.tagName[1]), block });
    }
    if (
      node.type === 'element' &&
      node.tagName === 'p' &&
      node.children.some((child) => child.type === 'element' && child.properties.dataEmbed)
    )
      node.tagName = 'div';
    for (const child of node.children) {
      delete child.position;
      if (child.type === 'element') visit(child, block);
    }
  };
  const blocks: HtmlBlock[] = [];
  // Flatten very long top-level lists/tables into bounded blocks for virtualization.
  for (const child of tree.children) {
    if (child.type === 'text' && !child.value.trim()) continue;
    if (child.type === 'element' && ['ul', 'ol'].includes(child.tagName) && child.children.length > 40) {
      const items = child.children.filter((node) => node.type === 'element');
      for (let i = 0; i < items.length; i += 20)
        blocks.push({
          ...child,
          properties: {
            ...child.properties,
            ...(child.tagName === 'ol' ? { start: Number(child.properties.start || 1) + i } : {}),
          },
          children: items.slice(i, i + 20),
        });
    } else if (child.type === 'element' && child.tagName === 'table') {
      const body = child.children.find((node) => node.type === 'element' && node.tagName === 'tbody') as
        Element | undefined;
      const rows = body?.children.filter((node) => node.type === 'element') || [];
      if (body && rows.length > 40) {
        const head = child.children.filter((node) => node.type === 'element' && node.tagName === 'thead');
        for (let i = 0; i < rows.length; i += 20)
          blocks.push({ ...child, children: [...head, { ...body, children: rows.slice(i, i + 20) }] });
      } else blocks.push(child);
    } else blocks.push(child);
  }
  blocks.forEach((block, index) => {
    if (block.type === 'element') visit(block, index);
  });
  const warnings = JSON.stringify(tree).match(/katex-error/g)?.length || 0;
  return {
    blocks,
    headings,
    anchors,
    properties: String(file.data.properties || ''),
    warnings,
    milliseconds: performance.now() - started,
    bytes: JSON.stringify(blocks).length * 2,
  };
}
