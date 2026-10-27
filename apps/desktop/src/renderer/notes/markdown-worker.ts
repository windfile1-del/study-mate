import { compileNote } from './markdown';
import { normalizeDisplayMath } from './math-source';
self.onmessage = async (event: MessageEvent<{ source: string }>) => {
  try {
    const source = normalizeDisplayMath(event.data.source);
    if (source.length > 60000) {
      let offset = 0,
        safe = 0,
        fence = '',
        math = false;
      for (const line of source.slice(0, 12000).split('\n')) {
        const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
        if (mark) fence = fence ? '' : mark[0];
        if (!fence && /^\s*\$\$\s*$/.test(line)) math = !math;
        offset += line.length + 1;
        if (!fence && !math && !line.trim()) safe = offset;
      }
      if (safe > 100)
        self.postMessage({
          ok: true,
          partial: true,
          json: JSON.stringify(await compileNote(source.slice(0, safe))),
        });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    self.postMessage({ ok: true, json: JSON.stringify(await compileNote(source)) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : '笔记解析失败' });
  }
};
