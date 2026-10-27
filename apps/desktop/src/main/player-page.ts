import type { PlayerRequest, PlayerState } from '../shared/player';
// Runs in the video page. It has no Node/IPC access and accepts only bounded commands.
export async function playerPage(command: PlayerRequest, wanted: boolean): Promise<PlayerState> {
  const host = window as any;
  const key = '__studyMateVideoFocusV1';
  const s = (host[key] ||= {
    video: null,
    focused: false,
    subtitles: true,
    styles: [],
    inline: [],
    tracks: [],
  });
  const captionSelector =
    '.bili-subtitle-x-subtitle-panel, .bpx-player-subtitle-wrap, .bilibili-player-video-subtitle';
  const find = (root: Document | ShadowRoot, depth = 0): HTMLVideoElement[] => {
    const found = [...root.querySelectorAll('video')];
    if (depth < 3 && !found.length)
      for (const el of [...root.querySelectorAll('*')].slice(0, 10000)) {
        if (el.shadowRoot) found.push(...find(el.shadowRoot, depth + 1));
        if (el instanceof HTMLIFrameElement) {
          try {
            if (
              el.contentDocument &&
              el.getBoundingClientRect().width > 0 &&
              el.getBoundingClientRect().height > 0
            )
              found.push(...find(el.contentDocument, depth + 1));
          } catch {}
        }
      }
    return found;
  };
  const video: HTMLVideoElement | null = s.video?.isConnected
    ? s.video
    : find(document)
        .filter((video) => {
          const rect = video.getBoundingClientRect(),
            style = video.ownerDocument.defaultView!.getComputedStyle(video);
          return (
            rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          );
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        })[0] || null;
  const restore = () => {
    for (const style of s.styles) style.remove();
    for (const [element, style] of s.inline) {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
      element.removeAttribute('data-studymate-keep');
    }
    for (const [track, mode] of s.tracks) {
      try {
        track.mode = mode;
      } catch {}
    }
    if (s.video) s.video.controls = s.controls;
    s.styles = [];
    s.inline = [];
    s.tracks = [];
    s.focused = false;
  };
  if (s.video !== video && s.focused) restore();
  s.video = video;
  if (!video) {
    if (s.focused) restore();
    return {
      available: false,
      focused: false,
      paused: true,
      time: 0,
      duration: 0,
      rate: 1,
      subtitles: false,
      captionsAvailable: false,
    };
  }
  const doc = video.ownerDocument;
  const styleElement = (owner: Document, css: string) => {
    const style = owner.createElement('style');
    style.textContent = css;
    (owner.head || owner.documentElement).appendChild(style);
    s.styles.push(style);
  };
  const setStyle = (el: HTMLElement, css: string) => {
    if (!s.inline.some((entry: any) => entry[0] === el)) s.inline.push([el, el.getAttribute('style')]);
    el.style.cssText += ';' + css;
  };
  const focus = () => {
    s.controls = video.controls;
    s.tracks = [...video.textTracks].map((track) => [track, track.mode]);
    s.activeTracks = [...video.textTracks].filter((track) => track.mode === 'showing');
    if (!s.activeTracks.length && video.textTracks.length) s.activeTracks = [video.textTracks[0]];
    const ancestors: HTMLElement[] = [];
    let parent = video.parentElement;
    while (parent) {
      ancestors.push(parent);
      parent = parent.parentElement;
    }
    for (const node of ancestors)
      setStyle(
        node,
        'transform:none!important;filter:none!important;perspective:none!important;contain:none!important;overflow:visible!important;clip:auto!important;clip-path:none!important;',
      );
    setStyle(
      video,
      'position:fixed!important;inset:0!important;margin:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;object-fit:contain!important;visibility:visible!important;z-index:2147483000!important;background:#10150f!important;',
    );
    setStyle(doc.documentElement, 'overflow:hidden!important;background:#10150f!important;');
    styleElement(
      doc,
      'body * {visibility:hidden!important;} video[data-studymate-keep], [data-studymate-keep="caption"], [data-studymate-keep="caption"] * {visibility:visible!important;}',
    );
    video.setAttribute('data-studymate-keep', 'video');
    if (doc !== document) {
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      if (frame) {
        setStyle(
          frame,
          'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483000!important;visibility:visible!important;border:0!important;',
        );
        setStyle(document.documentElement, 'overflow:hidden!important;');
        frame.setAttribute('data-studymate-keep', 'frame');
        styleElement(
          document,
          'body * {visibility:hidden!important;} iframe[data-studymate-keep="frame"] {visibility:visible!important;}',
        );
      }
    }
    // Shadow-root video needs its host chain to escape transformed containing blocks.
    let node: Node = video;
    while (node.getRootNode() instanceof ShadowRoot) {
      const shadow = node.getRootNode() as ShadowRoot;
      setStyle(
        shadow.host as HTMLElement,
        'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;transform:none!important;visibility:visible!important;z-index:2147483000!important;',
      );
      const shadowStyle = doc.createElement('style');
      shadowStyle.textContent = '*{visibility:hidden!important}';
      shadow.appendChild(shadowStyle);
      s.styles.push(shadowStyle);
      node = shadow.host;
      let ancestor = shadow.host.parentElement;
      while (ancestor) {
        setStyle(
          ancestor,
          'transform:none!important;filter:none!important;perspective:none!important;contain:none!important;overflow:visible!important;clip:auto!important;clip-path:none!important;',
        );
        ancestor = ancestor.parentElement;
      }
    }
    const caption = doc.querySelector<HTMLElement>(captionSelector);
    if (caption) {
      setStyle(
        caption,
        'position:fixed!important;left:8%!important;right:8%!important;bottom:7%!important;width:auto!important;height:auto!important;text-align:center!important;pointer-events:none!important;z-index:2147483500!important;color:white!important;text-shadow:0 1px 4px #000!important;',
      );
      caption.setAttribute('data-studymate-keep', 'caption');
    }
    video.controls = false;
    s.focused = true;
  };
  if (!wanted && s.focused) restore();
  if (wanted && !s.focused) focus();
  if (command.action === 'play') {
    try {
      await video.play();
    } catch {
      throw Error('网页未允许播放，请先在原网页点击一次播放。');
    }
  }
  if (command.action === 'pause') video.pause();
  if (command.action === 'seek') {
    if (!Number.isFinite(video.duration) || video.duration <= 0)
      throw Error('当前视频尚不可定位，或为直播。');
    video.currentTime = Math.min(command.time, video.duration);
  }
  if (command.action === 'rate') video.playbackRate = command.rate;
  if (command.action === 'subtitles') s.subtitles = command.enabled;
  if (s.focused) {
    const caption = doc.querySelector<HTMLElement>(captionSelector);
    for (const track of [...video.textTracks])
      track.mode =
        s.subtitles && !caption?.textContent?.trim() && s.activeTracks.includes(track) ? 'showing' : 'hidden';
    if (caption) {
      if (!s.inline.some((entry: any) => entry[0] === caption))
        setStyle(
          caption,
          'position:fixed!important;left:8%!important;right:8%!important;bottom:7%!important;width:auto!important;height:auto!important;text-align:center!important;pointer-events:none!important;z-index:2147483500!important;color:white!important;text-shadow:0 1px 4px #000!important;',
        );
      if (s.subtitles) caption.setAttribute('data-studymate-keep', 'caption');
      else caption.removeAttribute('data-studymate-keep');
    }
  }
  return {
    available: true,
    focused: s.focused,
    paused: video.paused,
    time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
    rate: Math.max(0.25, Math.min(4, video.playbackRate)),
    subtitles: s.focused ? s.subtitles : [...video.textTracks].some((t) => t.mode === 'showing'),
    captionsAvailable: video.textTracks.length > 0 || !!doc.querySelector(captionSelector),
  };
}
