import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DocumentInfo } from '../../shared/documents';
const images = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();
function Thumbnail({
  info,
  page,
  active,
  onClick,
  paused,
}: {
  info: DocumentInfo;
  page: number;
  active: boolean;
  onClick: () => void;
  paused: boolean;
}) {
  const key = info.id + ':' + page,
    [image, setImage] = useState(images.get(key) || ''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (image || paused || info.locked || info.kind === 'ppt') return;
    let live = true;
    const timer = setTimeout(() => {
      queue = queue
        .catch(() => {})
        .then(async () => {
          if (!live) return;
          try {
            const reply = await window.studyMate.document({
              action: 'page',
              id: info.id,
              page,
              width: 300,
              image: true,
            });
            if (!live) return;
            if (reply.page?.image) {
              images.set(key, reply.page.image);
              if (images.size > 96) images.delete(images.keys().next().value!);
              setImage(reply.page.image);
            }
          } catch {
            if (live) setFailed(true);
          }
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, paused, image]);
  const title = info.outline.find((o) => o.page === page)?.title || `第 ${page} 页`;
  return (
    <button
      className={'document-thumbnail ' + (active ? 'active' : '')}
      aria-label={`跳转第 ${page} 页：${title}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {image ? (
        <img alt={`第 ${page} 页缩略图`} src={image} loading="lazy" />
      ) : (
        <div className="thumbnail-placeholder">
          {info.kind === 'ppt' ? 'PPT · 文字页' : failed ? '预览暂不可用' : '第 ' + page + ' 页'}
        </div>
      )}
      <span>
        {page} · {title}
      </span>
    </button>
  );
}
export function PageThumbnails({
  info,
  page,
  onPage,
  busy,
}: {
  info: DocumentInfo;
  page: number;
  onPage: (page: number) => void;
  busy: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: info.pages,
    getScrollElement: () => scroll.current,
    estimateSize: () => 153,
    overscan: 2,
  });
  useEffect(() => {
    rows.scrollToIndex(page - 1, { align: 'center' });
  }, [page, info.id, rows.scrollRect?.height]);
  return (
    <div
      ref={scroll}
      className="thumbnail-scroll"
      aria-label="全部页面缩略预览"
      style={{ height: '100%', minHeight: 160, overflow: 'auto' }}
    >
      <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
        {rows.getVirtualItems().map((row) => (
          <div
            key={row.key}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              transform: `translateY(${row.start}px)`,
              height: row.size,
              paddingBottom: 9,
            }}
          >
            <Thumbnail
              info={info}
              page={row.index + 1}
              active={page === row.index + 1}
              paused={busy}
              onClick={() => onPage(row.index + 1)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
