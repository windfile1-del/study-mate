import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import PptxRenderer from 'pptx-browser';
import type { DocumentBlock, DocumentRegion } from '../../shared/documents';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
const assets = new URL('./pdf-assets/', location.href).href;
const cache = new Map<string, { pdf?: any; ppt?: any; used: number }>();
const renders = new Map<string, any>();
async function open(input: { id: string; url: string; kind: string; password?: string }) {
  let engine = cache.get(input.id);
  if (!engine) {
    const bytes = new Uint8Array(await (await fetch(input.url)).arrayBuffer());
    if (input.kind === 'pdf') {
      const task = pdfjs.getDocument({
        data: bytes,
        password: input.password,
        cMapUrl: assets + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: assets + 'standard_fonts/',
        wasmUrl: assets + 'wasm/',
        useSystemFonts: true,
      });
      try {
        engine = { pdf: await task.promise, used: Date.now() };
      } catch (e) {
        await task.destroy();
        throw e;
      }
    } else {
      const ppt = new PptxRenderer();
      await ppt.load(bytes);
      engine = { ppt, used: Date.now() };
    }
    cache.set(input.id, engine!);
    if (cache.size > 3) {
      const older = [...cache.entries()]
        .filter(([id]) => id !== input.id)
        .sort((a, b) => a[1].used - b[1].used)[0];
      cache.delete(older[0]);
      await older[1].pdf?.destroy();
      older[1].ppt?.destroy();
    }
  }
  engine!.used = Date.now();
  const outline: { title: string; page: number; depth: number }[] = [];
  if (engine!.pdf) {
    const pdf = engine!.pdf;
    const walk = async (items: any[], depth: number) => {
      for (const item of items || []) {
        if (outline.length >= 300) return;
        let page = 1;
        try {
          const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
          if (dest?.length)
            page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
        } catch {}
        outline.push({ title: String(item.title).slice(0, 200), page, depth });
        await walk(item.items, depth + 1);
      }
    };
    await walk(await pdf.getOutline(), 0);
    return { pages: pdf.numPages, outline };
  }
  const ppt = engine!.ppt;
  for (let index = 0; index < Math.min(ppt.slideCount, 500); index++) {
    const slide = await ppt.extractSlide(index);
    outline.push({
      title: (String(slide.title||'').trim() || slide.textShapes?.find((s:any)=>String(s.text||'').trim().length>2&&!/^\d+$/.test(String(s.text).trim()))?.text || `幻灯片 ${index + 1}`).trim().split('\n')[0].slice(0, 150),
      page: index + 1,
      depth: 0,
    });
  }
  return { pages: ppt.slideCount, outline };
}
async function page(input: {
  id: string;
  page: number;
  width: number;
  image: boolean;
  region?: DocumentRegion;
  job: string;
}) {
  const engine = cache.get(input.id);
  if (!engine) throw Error('文档引擎已释放，请重新打开此文档。');
  engine.used = Date.now();
  let width = input.width,
    height = 0,
    text = '',
    notes = '',
    blocks: DocumentBlock[] = [];
  const canvas = document.createElement('canvas');
  if (engine.pdf) {
    const page = await engine.pdf.getPage(input.page),
      base = page.getViewport({ scale: 1 }),
      viewport = page.getViewport({ scale: input.width / base.width });
    height = Math.round(viewport.height);
    if (!Number.isFinite(height) || height < 1 || height > 16000 || width * height > 8_000_000)
      throw Error('页面尺寸超过预览预算，请降低缩放后重试。');
    const content = await page.getTextContent();
    for (const item of content.items.slice(0, 10000))
      if ('str' in item) {
        const tx = pdfjs.Util.transform(viewport.transform, item.transform),
          fontHeight = Math.hypot(tx[2], tx[3]),
          style = content.styles[item.fontName];
        blocks.push({
          text: item.str,
          x: tx[4] / width,
          y: (tx[5] - fontHeight * (style?.ascent || 0.8)) / height,
          width: Math.max(0, (item.width * viewport.scale) / width),
          height: fontHeight / height,
        });
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
    if (input.image) {
      canvas.width = width;
      canvas.height = height;
      const render = page.render({ canvas, viewport });
      renders.set(input.job, render);
      try {
        await render.promise;
      } finally {
        renders.delete(input.job);
      }
    }
  } else {
    const slide = await engine.ppt.extractSlide(input.page - 1);
    text = slide.text || (await engine.ppt.extractText(input.page - 1)) || '';
    notes = (await engine.ppt.getSlideNotes(input.page - 1)) || '';
    height = Math.round((input.width * engine.ppt.slideSize.cy) / engine.ppt.slideSize.cx);
    if (!Number.isFinite(height) || height < 1 || height > 16000 || width * height > 8_000_000)
      throw Error('幻灯片尺寸超过预览预算。');
    if (input.image) await engine.ppt.renderSlide(input.page - 1, canvas, width);
  }
  const gaps: string[] = [];
  if (!text.trim())
    gaps.push('本页没有可提取文本，可能是扫描页或文字图片；可调用页面图像工具交给视觉模型，可按需调用本地OCR工具提取文字。');
  if (text.length > 64000) gaps.push('本页文字较多，返回文本已截断。');
  if (engine.ppt) gaps.push('幻灯片为静态预览，字体/SmartArt/复杂公式与动画可能与Office不同；未播放音视频。');
  if (input.region) {
    const r = input.region;
    text = blocks.length
      ? blocks
          .filter(
            (b) => b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y,
          )
          .map((b) => b.text)
          .join(' ')
      : text;
    if (input.image) {
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.round(width * r.width));
      crop.height = Math.max(1, Math.round(height * r.height));
      crop
        .getContext('2d')!
        .drawImage(
          canvas,
          width * r.x,
          height * r.y,
          width * r.width,
          height * r.height,
          0,
          0,
          crop.width,
          crop.height,
        );
      width = crop.width;
      height = crop.height;
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(crop, 0, 0);
    }
    if (!blocks.length) gaps.push('幻灯片文字未按选区裁剪，文字为整页提取；图像已按选区裁剪。');
    blocks = [];
  }
  const image = input.image ? canvas.toDataURL('image/webp', 0.87) : undefined;
  return {
    number: input.page,
    text: text.slice(0, 64000),
    notes: notes.slice(0, 16000),
    blocks: blocks.slice(0, 5000),
    width,
    height,
    image,
    gaps,
    region: input.region,
  };
}
(window as any).studyDocumentEngine = {
  async execute(action: string, input: any) {
    try {
      return { ok: true, value: action === 'open' ? await open(input) : await page(input) };
    } catch (e: any) {
      return {
        ok: false,
        error:
          e?.name === 'PasswordException'
            ? e.code === 2
              ? 'PDF_PASSWORD_INVALID'
              : 'PDF_PASSWORD_REQUIRED'
            : e?.message || '文档解析失败',
      };
    }
  },
  cancel(job: string) {
    renders.get(job)?.cancel();
  },
};
