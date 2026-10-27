// Obsidian accepts display delimiters sharing a line with their formula.
// micromark flow math expects a closing fence on its own line. Normalize only
// delimiter-at-line-start blocks, preserving fenced/indented code and containers.
export function normalizeDisplayMath(source: string): string {
  const rows = source.split(/\r?\n/),
    result: string[] = [];
  let fence = '',
    fenceLength = 0,
    math = false,
    mathPrefix = '',
    html = '';
  const delimiter = (value: string) => {
    for (let i = 0; i < value.length - 1; i++)
      if (value[i] === '$' && value[i + 1] === '$') {
        let escapes = 0;
        for (let p = i - 1; p >= 0 && value[p] === '\\'; p--) escapes++;
        if (!(escapes % 2)) return i;
      }
    return -1;
  };
  for (const row of rows) {
    const quote = /^([ \t]*(?:>[ \t]*)*)/.exec(row)![0];
    const content = row.slice(quote.length);
    if (!math) {
      const marker = /^(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})/.exec(content)?.[1];
      if (fence) {
        result.push(row);
        if (marker && marker[0] === fence && marker.length >= fenceLength && /^[`~]+\s*$/.test(content))
          fence = '';
        continue;
      }
      if (marker) {
        fence = marker[0];
        fenceLength = marker.length;
        result.push(row);
        continue;
      }
      if (html) {
        result.push(row);
        if (row.includes(html)) html = '';
        continue;
      }
      const tag = /^(?:<(pre|script|style)\b|<!--)/i.exec(content);
      if (tag) {
        html = tag[1] ? '</' + tag[1].toLowerCase() + '>' : '-->';
        if (row.toLowerCase().includes(html)) html = '';
        result.push(row);
        continue;
      }
      if (!content.startsWith('$$') || (/^[ \t]{4}/.test(row) && !row.trimStart().startsWith('>'))) {
        result.push(row);
        continue;
      }
      const tail = content.slice(2),
        end = delimiter(tail);
      result.push(quote + '$$');
      if (end >= 0) {
        if (tail.slice(0, end).trim()) result.push(quote + tail.slice(0, end));
        result.push(quote + '$$');
        if (tail.slice(end + 2).trim()) result.push(quote + tail.slice(end + 2));
      } else {
        if (tail.trim()) result.push(quote + tail);
        math = true;
        mathPrefix = quote;
      }
    } else {
      const body = row.startsWith(mathPrefix) ? row.slice(mathPrefix.length) : row;
      const end = delimiter(body);
      if (end < 0) result.push(row);
      else {
        if (body.slice(0, end).trim()) result.push(mathPrefix + body.slice(0, end));
        result.push(mathPrefix + '$$');
        math = false;
        if (body.slice(end + 2).trim()) result.push(mathPrefix + body.slice(end + 2));
      }
    }
  }
  return result.join('\n');
}
