import { ipcRenderer } from 'electron';
import { CHANNELS, type ObservationBinding, type Result, type ObservationInput } from '../shared/contracts';

// Deliberately no contextBridge export: remote pages receive no privileged API.
let seq = 0;
let lastFrameAt = 0;
let lastVisit = '';
let busy = false;
let lastSubtitle = '';
let lastSubtitleAt = -10;
let stopped = false;
let lastMediaFrame = -100;
let cacheEnabled = true,
  policyAt = 0;
const trackOffsets = new Map<TextTrack, number>();
function captions(video: HTMLVideoElement): NonNullable<ObservationInput['captions']> {
  const rows: NonNullable<ObservationInput['captions']> = [];
  for (const track of Array.from(video.textTracks)) {
    const cues = track.cues;
    if (!cues) continue;
    let offset = trackOffsets.get(track) || 0;
    if (offset > cues.length) offset = 0;
    for (; offset < cues.length && rows.length < 200; offset++) {
      const cue = cues[offset] as VTTCue;
      if (cue.endTime >= cue.startTime)
        rows.push({
          from: cue.startTime,
          to: cue.endTime,
          text: String(cue.text || '')
            .replace(/<[^>]*>/g, '')
            .slice(0, 5000),
          source: 'text-track',
        });
    }
    trackOffsets.set(track, offset);
    if (rows.length >= 200) break;
  }
  return rows;
}

function capture(video: HTMLVideoElement): ObservationInput['frame'] {
  const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas-unavailable');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const fingerprint = document.createElement('canvas');
  fingerprint.width = 8;
  fingerprint.height = 8;
  const small = fingerprint.getContext('2d', { willReadFrequently: true });
  if (!small) throw new Error('fingerprint-unavailable');
  small.drawImage(canvas, 0, 0, 8, 8);
  const data = small.getImageData(0, 0, 8, 8).data;
  const values: number[] = [];
  for (let i = 0; i < data.length; i += 4)
    values.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    timestamp: video.currentTime,
    width: canvas.width,
    height: canvas.height,
    data: canvas.toDataURL('image/webp', 0.62),
    hash: values.map((value) => (value >= average ? '1' : '0')).join(''),
    mimeType: 'image/webp',
    source: 'canvas',
    qualityLevel: 'preview',
  };
}
function subtitle(): string | null {
  for (const node of document.querySelectorAll<HTMLElement>(
    '.bili-subtitle-x-subtitle-panel-text, .bpx-player-subtitle-wrap',
  )) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
      if (text) return text;
    }
  }
  return null;
}
async function tick(): Promise<void> {
  if (busy || stopped) return;
  busy = true;
  try {
    const bound = (await ipcRenderer.invoke(CHANNELS.binding)) as Result<ObservationBinding | null>;
    if (!bound.ok || !bound.value) return;
    const binding = bound.value;
    if (Date.now() - policyAt > 5000) {
      const policy = await ipcRenderer.invoke(CHANNELS.observerPolicy);
      if (policy.ok) cacheEnabled = policy.value.enabled;
      policyAt = Date.now();
    }
    if (binding.visitId !== lastVisit) {
      lastVisit = binding.visitId;
      lastFrameAt = 0;
      seq = 0;
      lastSubtitle = '';
      lastMediaFrame = -100;
      trackOffsets.clear();
      lastSubtitleAt = -10;
    }
    const video = [...document.querySelectorAll('video')].sort(
      (a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight,
    )[0];
    if (!video) return;
    let frame: ObservationInput['frame'] = null;
    let frameStatus = 'not-requested';
    if (
      cacheEnabled &&
      (!lastFrameAt ||
        (!video.seeking &&
          Math.abs(video.currentTime - lastMediaFrame) >= 2 &&
          Date.now() - lastFrameAt >= 900))
    ) {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) frameStatus = 'video-not-ready';
      else {
        try {
          frame = capture(video);
          frameStatus = 'captured';
          lastFrameAt = Date.now();
          lastMediaFrame = video.currentTime;
        } catch (error) {
          frameStatus =
            error instanceof DOMException && error.name === 'SecurityError'
              ? 'canvas-security'
              : 'capture-unavailable';
        }
      }
    }
    let caption = subtitle();
    if (caption === lastSubtitle && Math.abs(video.currentTime - lastSubtitleAt) < 3) caption = null;
    else if (caption) {
      lastSubtitle = caption;
      lastSubtitleAt = video.currentTime;
    }
    await ipcRenderer.invoke(CHANNELS.observation, {
      binding,
      seq: seq++,
      url: binding.url.startsWith('study-local:') ? binding.url : location.href,
      title: document.title.slice(0, 500),
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
      playbackRate: video.playbackRate,
      frameStatus,
      frame,
      subtitle: caption,
      captions: captions(video),
    } satisfies ObservationInput);
  } catch {
    /* Navigation can destroy a preload between capture and delivery. */
  } finally {
    busy = false;
  }
}
window.addEventListener(
  'DOMContentLoaded',
  () => {
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    window.addEventListener(
      'unload',
      () => {
        stopped = true;
        clearInterval(timer);
      },
      { once: true },
    );
  },
  { once: true },
);
