import type { AnalysisInput, EvidenceFrame } from '../shared/contracts';

async function decode(input: AnalysisInput & { url: string }) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  document.body.append(video);
  const wait = (event: string, action: () => void) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error('视频加载或定位超时，请检查网络与视频编码。')),
        25000,
      );
      const done = () => finish();
      const failed = () => finish(new Error('内置解码器无法读取此视频（编码、权限或网络异常）。'));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        video.removeEventListener(event, done);
        video.removeEventListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener(event, done, { once: true });
      video.addEventListener('error', failed, { once: true });
      action();
    });
  try {
    await wait('loadeddata', () => {
      video.src = input.url;
      video.load();
    });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error('当前视频没有可定位的完整时长，暂不支持直播或实时流解析。');
    const start = input.start,
      end = Math.min(input.end ?? duration, duration);
    if (start >= end || start >= duration) throw new Error('解析起点需小于终点，且位于视频时长内。');
    const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d')!;
    const frames: EvidenceFrame[] = [];
    for (let i = 0; i < input.count; i++) {
      // Avoid the undecodable exact end-of-file position.
      const timestamp = Math.min(
        duration - Math.min(0.08, duration / 10),
        start + (end - start) * (input.count === 1 ? 0.5 : i / (input.count - 1)),
      );
      let frameTime = video.currentTime;
      if (Math.abs(video.currentTime - timestamp) > 0.001) {
        let callback = 0;
        let frameTimeout: ReturnType<typeof setTimeout> | undefined;
        const rendered = new Promise<void>((resolve, reject) => {
          frameTimeout = setTimeout(
            () => reject(new Error('未能获取目标位置的解码画面，该文件的索引或帧率可能不支持精确抽帧。')),
            25000,
          );
          const accept: VideoFrameRequestCallback = (_now, metadata) => {
            // A callback already queued for the old picture can arrive after seeking.
            if (Math.abs(metadata.mediaTime - timestamp) <= 0.25) {
              frameTime = metadata.mediaTime;
              resolve();
            } else callback = video.requestVideoFrameCallback(accept);
          };
          callback = video.requestVideoFrameCallback(accept);
        });
        try {
          await Promise.all([
            rendered,
            wait('seeked', () => {
              video.currentTime = timestamp;
            }),
          ]);
        } finally {
          clearTimeout(frameTimeout);
          video.cancelVideoFrameCallback(callback);
        }
      }
      if (video.readyState < 2) await wait('loadeddata', () => {});
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({
        id: String(i),
        timestamp: frameTime,
        width: canvas.width,
        height: canvas.height,
        data: canvas.toDataURL('image/webp', 0.9),
        sceneCut: false,
      });
    }
    return { duration, width: video.videoWidth, height: video.videoHeight, frames };
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}
(window as unknown as { studyMateDecodeJob: typeof decode }).studyMateDecodeJob = decode;
