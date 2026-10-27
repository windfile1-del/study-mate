import { finiteNumber } from "../browser/BrowserAdapter.mjs";

export const FRAME_SOURCES = Object.freeze(["canvas", "browser-crop", "ffmpeg"]);

export function validateFrame(frame = {}) {
  if (!frame || typeof frame !== "object") throw new TypeError("Frame must be an object.");
  if (!Number.isFinite(Number(frame.timestamp)) || Number(frame.timestamp) < 0) {
    throw new TypeError("Frame timestamp must be a non-negative number.");
  }
  if (frame.data != null && typeof frame.data !== "string") throw new TypeError("Frame data must be a string.");
  if (typeof frame.data === "string" && frame.data.length > 30_000_000) throw new RangeError("Frame data is too large.");
  return {
    timestamp: finiteNumber(frame.timestamp),
    width: Math.max(0, Math.floor(finiteNumber(frame.width))),
    height: Math.max(0, Math.floor(finiteNumber(frame.height))),
    originalWidth: Math.max(0, Math.floor(finiteNumber(frame.originalWidth, frame.width))),
    originalHeight: Math.max(0, Math.floor(finiteNumber(frame.originalHeight, frame.height))),
    qualityLevel: String(frame.qualityLevel || (frame.source === "ffmpeg" ? "hq" : "preview")).slice(0, 24),
    scale: Math.min(1, Math.max(0, finiteNumber(frame.scale, 1))),
    mimeType: String(frame.mimeType || "image/webp"),
    source: FRAME_SOURCES.includes(frame.source) ? frame.source : "canvas",
    status: String(frame.status || (frame.data ? "captured" : "unavailable")).slice(0, 40),
    errorCode: frame.errorCode ? String(frame.errorCode).slice(0, 80) : null,
    data: frame.data || null,
    hash: typeof frame.hash === "string" && /^[01]{64}$/.test(frame.hash) ? frame.hash : null,
    pixels: Array.isArray(frame.pixels) ? frame.pixels.slice(0, 4096) : [],
    histogram: Array.isArray(frame.histogram) ? frame.histogram.slice(0, 256) : [],
    edges: Array.isArray(frame.edges) ? frame.edges.slice(0, 256) : [],
    metrics: frame.metrics && typeof frame.metrics === "object" ? { ...frame.metrics } : {},
    ocrText: frame.ocrText ? String(frame.ocrText).slice(0, 20_000) : ""
  };
}

export class FrameCapture {
  captureFromSnapshot(snapshot) {
    if (!snapshot?.frame || (snapshot.frame.errorCode && !snapshot.frame.data)) return null;
    return validateFrame({ ...snapshot.frame, timestamp: snapshot.currentTime });
  }

  classifyFallback({ canvasError = null, screenshotAvailable = false, mediaToolsAvailable = false } = {}) {
    if (!canvasError) return { source: "canvas", reason: "decoded-frame-copy" };
    if (screenshotAvailable) return { source: "browser-crop", reason: "canvas-unavailable" };
    if (mediaToolsAvailable) return { source: "ffmpeg", reason: "browser-capture-unavailable" };
    return { source: null, reason: "no-frame-source-available" };
  }
}
