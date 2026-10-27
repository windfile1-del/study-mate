import { BrowserWindow, type Session } from 'electron';
import type { AnalysisInput, MediaAnalysis } from '../shared/contracts';
// Runs in a separate page and only touches that page's own video element.
async function samplePage(input: AnalysisInput) {
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
  const until = async (fn: () => boolean, timeout = 20000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeout) throw Error('后台课程播放器未准备好；请确认已登录且有权访问。');
      await sleep(100);
    }
  };
  await until(
    () =>
      Array.from(document.querySelectorAll('video')).some(
        (v) => v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0,
      ),
    25000,
  );
  const video = Array.from(document.querySelectorAll('video')).sort(
    (a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight,
  )[0];
  video.muted = true;
  video.volume = 0;
  video.pause();
  const duration = video.duration,
    end = Math.min(input.end ?? duration, duration),
    start = Math.min(input.start, duration);
  if (end <= start) throw Error('指定片段超出视频可读取范围');
  const frames: MediaAnalysis['frames'] = [];
  for (let i = 0; i < input.count; i++) {
    const target = Math.min(
      duration - 0.03,
      input.count === 1 ? (start + end) / 2 : start + ((end - start) * i) / (input.count - 1),
    );
    const ready = new Promise<number>((resolve, reject) => {
      let done = false;
      let handle = 0;
      const timer = setTimeout(() => {
        done = true;
        video.cancelVideoFrameCallback(handle);
        reject(Error('后台片段未解码到指定时间'));
      }, 15000);
      const check = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (done) return;
        if (Math.abs(meta.mediaTime - target) < 0.35) {
          done = true;
          clearTimeout(timer);
          resolve(meta.mediaTime);
        } else handle = video.requestVideoFrameCallback(check);
      };
      handle = video.requestVideoFrameCallback(check);
    });
    void ready.catch(() => {});
    video.currentTime = target;
    await video.play();
    const timestamp = await ready;
    video.pause();
    const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight),
      canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw Error('后台画面解码不可用');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push({
      id: '',
      timestamp,
      width: canvas.width,
      height: canvas.height,
      data: canvas.toDataURL('image/webp', 0.72),
      sceneCut: false,
    });
  }
  return { frames, duration, width: video.videoWidth, height: video.videoHeight };
}
export async function decodeOnlinePage(
  url: string,
  input: AnalysisInput,
  ses: Session,
  signal: AbortSignal,
): Promise<Pick<MediaAnalysis, 'duration' | 'width' | 'height' | 'frames'>> {
  signal.throwIfAborted();
  const worker = new BrowserWindow({
    show: false,
    width: 960,
    height: 600,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      webSecurity: true,
      offscreen: true,
    },
  });
  worker.webContents.setAudioMuted(true);
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  worker.webContents.on('will-attach-webview', (e) => e.preventDefault());
  worker.webContents.on('will-navigate', (e, target) => {
    if (!/^https?:\/\//i.test(target)) e.preventDefault();
  });
  const close = () => {
    if (!worker.isDestroyed()) worker.destroy();
  };
  const timer = setTimeout(close, 90000);
  signal.addEventListener('abort', close, { once: true });
  try {
    await worker.loadURL(url);
    signal.throwIfAborted();
    return await worker.webContents.executeJavaScript(
      `(${samplePage.toString()})(${JSON.stringify(input)})`,
      true,
    );
  } catch (e) {
    signal.throwIfAborted();
    throw Error(
      '在线课程后台观看失败：' +
        (e as Error).message +
        '；缓存、字幕仍可使用。跨域内嵌、DRM或站点限制可能不支持。',
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', close);
    close();
  }
}
