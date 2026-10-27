const SENSITIVE_QUERY_KEYS = /^(sessdata|bili_jct|dedeuserid|dedeuserid__ckmd5|ac_time_value|access_key|token|cookie|auth|authorization)$/i;

export const READ_ONLY_PLAYER_FIELDS = Object.freeze([
  "url",
  "title",
  "bvid",
  "cid",
  "currentTime",
  "duration",
  "videoWidth",
  "videoHeight",
  "videoElementCount",
  "videoReadyState",
  "paused",
  "playbackRate",
  "volume",
  "videoRect",
  "frame",
  "frameStatus",
  "frameErrorCode",
  "frameAvailable",
  "frameSource"
]);

export class ReadOnlyViolation extends Error {
  constructor(message = "The foreground player is read-only.") {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

export function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizedCode(value) {
  if (!value) return null;
  const code = String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80);
  return code || null;
}

export function sanitizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function extractVideoId(urlValue) {
  const url = sanitizeUrl(urlValue);
  if (!url) return { bvid: null, cid: null };
  const parsed = new URL(url);
  const bvidMatch = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  const avMatch = parsed.pathname.match(/\/video\/av(\d+)/i);
  // p is a part ordinal, not Bilibili's content cid. The host tracks parts.
  const cid = parsed.searchParams.get("cid") || null;
  return {
    bvid: bvidMatch?.[1] || (avMatch ? "av" + avMatch[1] : null),
    cid: cid ? String(cid) : null
  };
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  return Object.freeze({
    x: finiteNumber(rect.x),
    y: finiteNumber(rect.y),
    width: Math.max(0, finiteNumber(rect.width)),
    height: Math.max(0, finiteNumber(rect.height))
  });
}

function normalizeFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  const data = typeof frame.data === "string" ? frame.data : null;
  if (data && data.length > 30_000_000) return null;
  return Object.freeze({
    timestamp: Math.max(0, finiteNumber(frame.timestamp)),
    mimeType: String(frame.mimeType || "image/webp").slice(0, 100),
    width: Math.max(0, Math.floor(finiteNumber(frame.width))),
    height: Math.max(0, Math.floor(finiteNumber(frame.height))),
    originalWidth: Math.max(0, Math.floor(finiteNumber(frame.originalWidth, frame.width))),
    originalHeight: Math.max(0, Math.floor(finiteNumber(frame.originalHeight, frame.height))),
    qualityLevel: String(frame.qualityLevel || "preview").slice(0, 24),
    scale: Math.min(1, Math.max(0, finiteNumber(frame.scale, 1))),
    source: String(frame.source || "canvas").slice(0, 40),
    status: String(frame.status || (data ? "captured" : "unavailable")).slice(0, 40),
    errorCode: normalizedCode(frame.errorCode),
    data,
    hash: typeof frame.hash === "string" && /^[01]{64}$/.test(frame.hash) ? frame.hash : null,
    pixels: Array.isArray(frame.pixels) ? frame.pixels.slice(0, 4096) : [],
    histogram: Array.isArray(frame.histogram) ? frame.histogram.slice(0, 256) : [],
    edges: Array.isArray(frame.edges) ? frame.edges.slice(0, 256) : [],
    metrics: frame.metrics && typeof frame.metrics === "object" ? Object.freeze({ ...frame.metrics }) : Object.freeze({}),
    ocrText: frame.ocrText ? String(frame.ocrText).slice(0, 20_000) : ""
  });
}

export function normalizeSnapshot(raw = {}) {
  if (!raw || typeof raw !== "object") throw new TypeError("A browser snapshot must be an object.");
  const url = sanitizeUrl(raw.url);
  const ids = extractVideoId(url);
  const currentTime = Math.max(0, finiteNumber(raw.currentTime));
  const duration = Math.max(currentTime, finiteNumber(raw.duration));
  const frameProvided = raw.frame !== undefined && raw.frame !== null;
  const frame = normalizeFrame(raw.frame);
  const frameAvailable = Boolean(frame?.data);
  const frameStatus = String(raw.frameStatus || frame?.status || (frameProvided ? (frame ? (frameAvailable ? "captured" : "unavailable") : "invalid") : "not-requested")).slice(0, 40);
  const frameErrorCode = normalizedCode(raw.frameErrorCode || frame?.errorCode || (frameProvided && !frame ? "frame-invalid" : null));
  return Object.freeze({
    url,
    title: raw.title ? String(raw.title).slice(0, 500) : null,
    bvid: raw.bvid ? String(raw.bvid) : ids.bvid,
    cid: raw.cid ? String(raw.cid) : ids.cid,
    currentTime,
    duration,
    videoWidth: Math.max(0, Math.floor(finiteNumber(raw.videoWidth))),
    videoHeight: Math.max(0, Math.floor(finiteNumber(raw.videoHeight))),
    videoElementCount: Math.min(100, Math.max(0, Math.floor(finiteNumber(raw.videoElementCount)))),
    videoReadyState: Math.min(4, Math.max(0, Math.floor(finiteNumber(raw.videoReadyState)))),
    paused: Boolean(raw.paused),
    playbackRate: Math.max(0, finiteNumber(raw.playbackRate, 1)),
    volume: Math.min(1, Math.max(0, finiteNumber(raw.volume, 1))),
    videoRect: normalizeRect(raw.videoRect),
    frame,
    frameStatus,
    frameErrorCode,
    frameAvailable,
    frameSource: frame?.source || null,
    observedAt: String(raw.observedAt || new Date().toISOString()).slice(0, 80)
  });
}

export function immutablePlayerView(snapshot) {
  const value = Object.freeze({ ...snapshot });
  return new Proxy(value, {
    set() {
      throw new ReadOnlyViolation("Player snapshots cannot be modified.");
    },
    defineProperty() {
      throw new ReadOnlyViolation("Player snapshots cannot be modified.");
    },
    deleteProperty() {
      throw new ReadOnlyViolation("Player snapshots cannot be modified.");
    }
  });
}

export class BrowserAdapter {
  #bridgeUrl;
  #snapshot = null;

  constructor({ bridgeUrl = process.env.BILIBILI_OBSERVER_BRIDGE_URL } = {}) {
    this.#bridgeUrl = bridgeUrl || null;
  }

  get bridgeConfigured() {
    return Boolean(this.#bridgeUrl);
  }

  ingestSnapshot(raw) {
    this.#snapshot = normalizeSnapshot(raw);
    return immutablePlayerView(this.#snapshot);
  }

  readSnapshot() {
    return this.#snapshot ? immutablePlayerView(this.#snapshot) : null;
  }

  async readFromBridge() {
    if (!this.#bridgeUrl) return this.readSnapshot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(this.#bridgeUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Bridge returned HTTP " + response.status + ".");
      const payload = await response.json();
      return this.ingestSnapshot(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  get capabilities() {
    return {
      readOnly: true,
      readableFields: [...READ_ONLY_PLAYER_FIELDS],
      bridgeConfigured: this.bridgeConfigured,
      frameSources: ["canvas", "browser-crop", "ffmpeg"]
    };
  }
}
