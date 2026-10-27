import crypto from "node:crypto";
import { BilibiliBrowserAdapter } from "./browser/BilibiliAdapter.mjs";
import { FrameCapture, validateFrame } from "./video/FrameCapture.mjs";
import { AdaptiveSampler } from "./video/AdaptiveSampler.mjs";
import { SceneDetector } from "./analysis/SceneDetector.mjs";
import { KeyframeRanker } from "./analysis/KeyframeRanker.mjs";
import { SubtitleTimeline } from "./subtitle/SubtitleTimeline.mjs";
import { RingBuffer } from "./cache/RingBuffer.mjs";
import { SessionStore } from "./cache/SessionStore.mjs";
import { FrameArchive } from "./cache/FrameArchive.mjs";

function sessionId(snapshot) {
  const base = snapshot.bvid || snapshot.url || "unidentified-video";
  return snapshot.cid ? `${base}-cid-${snapshot.cid}` : base;
}

function uniqueId(prefix, timestamp) {
  return `${prefix}-${Math.round(Number(timestamp) * 1000)}-${crypto.randomBytes(3).toString("hex")}`;
}

function intersects(item, start, end) {
  return item.timestamp >= start && item.timestamp <= end;
}

function stripSnapshotData(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot || null;
  const { frame, ...metadata } = snapshot;
  return { ...metadata, frame: frame ? (({ data, ...rest }) => rest)(frame) : frame || null };
}

export class TemporalIndex {
  constructor({
    adapter = new BilibiliBrowserAdapter(),
    sessionStore = new SessionStore(),
    archive = new FrameArchive(sessionStore.dataDir),
    maxPreviewDuration = 300,
    archiveIntervalMs = process.env.BILIBILI_OBSERVER_FRAME_ARCHIVE_INTERVAL_MS || 15_000
  } = {}) {
    this.adapter = adapter;
    this.sessionStore = sessionStore;
    this.archive = archive;
    this.capture = new FrameCapture();
    this.sampler = new AdaptiveSampler();
    this.sceneDetector = new SceneDetector();
    this.ranker = new KeyframeRanker();
    this.sessions = new Map();
    this.currentSessionId = null;
    this.maxPreviewDuration = maxPreviewDuration;
    this.archiveIntervalMs = Math.min(20_000, Math.max(900, Number(archiveIntervalMs) || 15_000));
    this.lastArchiveAt = new Map();
    this.archiveError = null;
    this.initialized = false;
  }

  #newSession(snapshot) {
    const id = sessionId(snapshot);
    if (this.currentSessionId !== id) {
      this.sampler.reset();
      this.sceneDetector.reset();
    }
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const value = {
      id,
      title: snapshot.title,
      url: snapshot.url,
      bvid: snapshot.bvid,
      cid: snapshot.cid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned: true,
      snapshot,
      preview: new RingBuffer({ maxDuration: this.maxPreviewDuration }),
      hqFrames: [],
      archiveFrames: [],
      archiveFrameCount: 0,
      archiveFolder: this.archive?.sessionDirectory(id) || null,
      archiveDataHydrated: true,
      subtitles: new SubtitleTimeline(),
      ocr: [],
      scenes: []
    };
    this.sessions.set(id, value);
    return value;
  }

  async initialize() {
    if (this.initialized) return { restoredSessions: this.sessions.size, archive: this.archive?.status() || null };
    const archiveState = this.archive ? await this.archive.initialize() : null;
    if (this.archive) {
      const records = await this.archive.listSessions({ includeData: false });
      for (const record of records) this.#restoreSession(record);
      if (records.length) this.currentSessionId = records.at(-1).id;
    }
    this.initialized = true;
    return { restoredSessions: this.sessions.size, archive: archiveState };
  }

  #restoreSession(record) {
    if (!record?.id) return null;
    const session = {
      id: record.id,
      title: record.title || record.snapshot?.title || null,
      url: record.url || record.snapshot?.url || null,
      bvid: record.bvid || record.snapshot?.bvid || null,
      cid: record.cid || record.snapshot?.cid || null,
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
      pinned: record.pinned !== false,
      snapshot: record.snapshot || null,
      preview: new RingBuffer({ maxDuration: this.maxPreviewDuration }),
      hqFrames: Array.isArray(record.hqFrames) ? record.hqFrames : [],
      archiveFrames: Array.isArray(record.archiveFrames) ? record.archiveFrames : [],
      archiveFrameCount: Number(record.archiveFrameCount) || (record.archiveFrames || []).length || 0,
      archiveFolder: record.archiveFolder || this.archive?.sessionDirectory(record.id) || null,
      archiveDataHydrated: Boolean(record.archiveDataHydrated),
      subtitles: new SubtitleTimeline(),
      ocr: Array.isArray(record.ocr) ? record.ocr : [],
      scenes: Array.isArray(record.scenes) ? record.scenes : []
    };
    for (const frame of session.archiveFrames) session.preview.add(frame);
    session.subtitles.add(record.subtitles || []);
    this.sessions.set(session.id, session);
    return session;
  }

  #saveSession(session) {
    if (!this.archive || !session) return;
    void this.archive.saveSession(session).catch(error => {
      this.archiveError = String(error?.message || error || "archive-save-failed").slice(0, 240);
    });
  }

  #archiveObservedFrame(session, entry) {
    if (!this.archive || !session || !entry?.data) return;
    const now = Date.now();
    const previousAt = this.lastArchiveAt.get(session.id) || 0;
    const previousFrame = session.archiveFrames.at(-1);
    if (previousFrame && Math.abs(Number(previousFrame.timestamp) - Number(entry.timestamp)) < 0.4) return;
    if (previousAt && now - previousAt < this.archiveIntervalMs) return;
    this.lastArchiveAt.set(session.id, now);
    session.archiveFrames.push({ ...entry });
    session.archiveFrameCount = session.archiveFrames.length;
    void this.archive.archiveFrame(session, entry, "preview")
      .then(() => this.archive.saveSession(session))
      .catch(error => {
        this.archiveError = String(error?.message || error || "frame-archive-failed").slice(0, 240);
      });
  }

  resolveSession(id = null) {
    if (!id) return this.currentSession();
    const needle = String(id);
    return this.sessions.get(needle)
      || [...this.sessions.values()].find(session => session.bvid === needle || `${session.bvid}-cid-${session.cid}` === needle)
      || null;
  }

  async hydrateArchive(id = null) {
    const session = this.resolveSession(id);
    if (!session || session.archiveDataHydrated || !this.archive) return session;
    const frames = await this.archive.loadFrames(session.id, { includeData: true });
    if (frames.length) {
      session.archiveFrames = frames;
      session.archiveFrameCount = Math.max(session.archiveFrameCount || 0, frames.length);
      session.preview.clear();
      for (const frame of frames) session.preview.add(frame);
    }
    session.archiveDataHydrated = true;
    return session;
  }

  ingestSnapshot(raw) {
    const snapshot = this.adapter.ingestSnapshot(raw);
    const session = this.#newSession(snapshot);
    session.snapshot = snapshot;
    session.title = snapshot.title || session.title;
    session.updatedAt = new Date().toISOString();
    this.currentSessionId = session.id;
    const frame = this.capture.captureFromSnapshot(snapshot);
    if (frame) this.ingestFrame(frame, session);
    this.#saveSession(session);
    return this.status();
  }

  ingestFrame(rawFrame, targetSession = this.currentSession()) {
    if (!targetSession) throw new Error("No active video session.");
    const frame = validateFrame(rawFrame);
    const scene = this.sceneDetector.observe(frame);
    const plan = this.sampler.nextPlan({
      timestamp: frame.timestamp,
      motionScore: frame.metrics.motionScore,
      sceneCut: scene.sceneCut,
      sourceWidth: frame.originalWidth || frame.width,
      sourceHeight: frame.originalHeight || frame.height,
      metrics: frame.metrics
    });
    const entry = {
      id: uniqueId("preview", frame.timestamp),
      ...frame,
      scene: scene.scene,
      sceneCut: scene.sceneCut,
      comparison: scene.comparison,
      informationScore: plan.preview.quality.score,
      previewWidth: plan.preview.width,
      previewHeight: plan.preview.height,
      originalWidth: frame.originalWidth,
      originalHeight: frame.originalHeight,
      qualityLevel: frame.qualityLevel,
      scale: frame.scale,
      sampled: plan.capture,
      cachedAt: new Date().toISOString()
    };
    // The ring buffer remains intentionally short for fast live queries. The
    // archive is the durable, per-video timeline and receives one frame per
    // configured 10-20 second interval, including frames that the adaptive
    // sampler does not select for the live buffer.
    this.#archiveObservedFrame(targetSession, entry);
    if (plan.capture || scene.sceneCut || targetSession.preview.size === 0) targetSession.preview.add(entry);
    const detail = plan.preview.quality.preserveSource || scene.sceneCut || Boolean(frame.metrics.hq);
    const hqAvailable = frame.qualityLevel === "hq" || Boolean(frame.metrics.hq);
    if (detail && hqAvailable) this.addHqFrame({ ...entry, source: frame.source, hq: true }, targetSession);
    if (frame.ocrText) targetSession.ocr.push({ timestamp: frame.timestamp, text: frame.ocrText, scene: scene.scene });
    targetSession.scenes.push({ timestamp: frame.timestamp, scene: scene.scene, sceneCut: scene.sceneCut });
    targetSession.updatedAt = new Date().toISOString();
    return entry;
  }

  addHqFrame(rawFrame, targetSession = this.currentSession()) {
    if (!targetSession) throw new Error("No active video session.");
    const frame = validateFrame(rawFrame);
    const existing = targetSession.hqFrames.find(item => Math.abs(item.timestamp - frame.timestamp) < 0.4);
    if (existing) return existing;
    const entry = { id: uniqueId("hq", frame.timestamp), ...frame, hq: true, cachedAt: new Date().toISOString() };
    targetSession.hqFrames.push(entry);
    targetSession.hqFrames.sort((a, b) => a.timestamp - b.timestamp);
    return entry;
  }

  ingestBackfillFrames(frames = [], targetSession = this.currentSession()) {
    if (!targetSession) throw new Error("No active video session.");
    const added = (Array.isArray(frames) ? frames : []).map(frame => this.addHqFrame({ ...frame, source: "ffmpeg", hq: true }, targetSession));
    this.#saveSession(targetSession);
    return added;
  }

  hasFrameAt(timestamp, tolerance = 0.75, targetSession = this.currentSession()) {
    if (!targetSession) return false;
    const center = Math.max(0, Number(timestamp) || 0);
    const span = Math.max(0, Number(tolerance) || 0);
    return targetSession.hqFrames.some(frame => Math.abs(frame.timestamp - center) <= span)
      || targetSession.archiveFrames.some(frame => Math.abs(frame.timestamp - center) <= span)
      || targetSession.preview.range(Math.max(0, center - span), center + span).length > 0;
  }

  hasHqFrameAt(timestamp, tolerance = 0.75, targetSession = this.currentSession()) {
    if (!targetSession) return false;
    const center = Math.max(0, Number(timestamp) || 0);
    const span = Math.max(0, Number(tolerance) || 0);
    return targetSession.hqFrames.some(frame => Math.abs(frame.timestamp - center) <= span);
  }

  ingestSubtitles(payload, targetSession = this.currentSession()) {
    if (!targetSession) throw new Error("No active video session.");
    if (typeof payload === "string") targetSession.subtitles.addSrt(payload);
    else if (payload?.srt) targetSession.subtitles.addSrt(payload.srt, payload.source || "bilibili");
    else if (Array.isArray(payload?.entries)) targetSession.subtitles.add(payload.entries, payload.source || "bilibili");
    else if (Array.isArray(payload)) targetSession.subtitles.add(payload);
    targetSession.updatedAt = new Date().toISOString();
    this.#saveSession(targetSession);
    return targetSession.subtitles.size;
  }

  currentSession() {
    return this.currentSessionId ? this.sessions.get(this.currentSessionId) || null : null;
  }

  async syncBridge() {
    const snapshot = await this.adapter.readFromBridge();
    if (!snapshot) return null;
    return this.ingestSnapshot(snapshot);
  }

  status() {
    const session = this.currentSession();
    const snapshot = session?.snapshot || this.adapter.readSnapshot();
    const preview = session?.preview;
    return {
      title: snapshot?.title || session?.title || null,
      bvid: snapshot?.bvid || session?.bvid || null,
      cid: snapshot?.cid || session?.cid || null,
      url: snapshot?.url || session?.url || null,
      currentTime: snapshot?.currentTime ?? null,
      duration: snapshot?.duration ?? null,
      resolution: snapshot ? { width: snapshot.videoWidth, height: snapshot.videoHeight } : null,
      videoElementCount: snapshot?.videoElementCount ?? 0,
      videoReadyState: snapshot?.videoReadyState ?? 0,
      paused: snapshot?.paused ?? null,
      playbackRate: snapshot?.playbackRate ?? null,
      observedAt: snapshot?.observedAt ?? null,
      frameAvailable: Boolean(snapshot?.frameAvailable),
      frameStatus: snapshot?.frameStatus || "not-requested",
      frameErrorCode: snapshot?.frameErrorCode || null,
      frameSource: snapshot?.frameSource || null,
      previewResolution: snapshot?.frame?.data ? { width: snapshot.frame.width, height: snapshot.frame.height } : null,
      previewScale: snapshot?.frame?.data ? snapshot.frame.scale : null,
      subtitleAvailable: Boolean(session?.subtitles.size),
      subtitleCount: session?.subtitles.size || 0,
      bufferStart: preview?.start ?? null,
      bufferEnd: preview?.end ?? null,
      previewFrames: preview?.size || 0,
      hqFrames: session?.hqFrames.length || 0,
      archive: this.archive ? { ...this.archive.status(session), frameIntervalMs: this.archiveIntervalMs } : null,
      archiveFrameCount: session?.archiveFrameCount || 0,
      archiveError: this.archiveError,
      sessionId: session?.id || null,
      readOnly: true,
      limitations: {
        canvas: "Requires a browser bridge to provide a decoded current frame.",
        subtitles: "Only ingested/bridge-provided subtitle tracks are indexed; no credentials are returned.",
        mediaBackfill: "When explicitly requested and enabled, local yt-dlp and FFmpeg extract historical frames in a separate process without changing foreground playback.",
        archive: "Preview frames are archived per video in the temporary videos directory; normal process restarts do not clear them, while a detected OS reboot does."
      }
    };
  }

  #range(start, end, session = this.currentSession()) {
    if (!session) return { session: null, preview: [], hq: [], subtitles: [], ocr: [], scenes: [] };
    const from = Math.max(0, Number(start) || 0);
    const to = Math.max(from, Number(end) || 0);
    const ring = session.preview.range(from, to);
    const archived = (session.archiveFrames || []).filter(frame => intersects(frame, from, to));
    const seen = new Set();
    const preview = [...ring, ...archived].filter(frame => {
      const key = `${Number(frame.timestamp).toFixed(3)}|${frame.source || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.timestamp - b.timestamp);
    return {
      session,
      preview,
      hq: session.hqFrames.filter(frame => intersects(frame, from, to)).map(frame => ({ ...frame })),
      subtitles: session.subtitles.range(from, to),
      ocr: session.ocr.filter(item => item.timestamp >= from && item.timestamp <= to).map(item => ({ ...item })),
      scenes: session.scenes.filter(item => item.timestamp >= from && item.timestamp <= to).map(item => ({ ...item }))
    };
  }

  current() {
    const snapshot = this.currentSession()?.snapshot || this.adapter.readSnapshot();
    const timestamp = snapshot?.currentTime ?? 0;
    return this.context(timestamp, 5, 5);
  }

  recent(seconds = 30) {
    const now = this.currentSession()?.snapshot?.currentTime ?? 0;
    const span = Math.min(300, Math.max(1, Number(seconds) || 30));
    return this.context(now, span, 0);
  }

  context(timestamp, before = 10, after = 10, query = "") {
    const center = Math.max(0, Number(timestamp) || 0);
    const range = this.#range(Math.max(0, center - Math.max(0, Number(before) || 0)), center + Math.max(0, Number(after) || 0));
    const selected = this.ranker.select([...range.hq, ...range.preview], { query, subtitles: range.subtitles, limit: 8 });
    return this.#packet(range, { center, before, after, frames: selected });
  }

  find(query, limit = 20, sessionId = null) {
    const session = this.resolveSession(sessionId);
    if (!session) return { query, matches: [], readOnly: true };
    const subtitleMatches = session.subtitles.search(query, { limit });
    const needle = String(query || "").toLowerCase();
    const ocrMatches = session.ocr.filter(item => item.text.toLowerCase().includes(needle)).slice(0, limit);
    const timestamps = [...new Set([...subtitleMatches.map(item => item.from), ...ocrMatches.map(item => item.timestamp)])].sort((a, b) => a - b);
    return { query, matches: timestamps.map(timestamp => ({ timestamp, subtitles: subtitleMatches.filter(item => Math.abs(item.from - timestamp) < 2), ocr: ocrMatches.filter(item => Math.abs(item.timestamp - timestamp) < 2) })), readOnly: true };
  }

  keyframes(start, end, query = "", limit = 6, sessionId = null) {
    const session = this.resolveSession(sessionId);
    const range = this.#range(Math.max(0, Number(start) || 0), Math.max(0, Number(end) || 0), session);
    const from = Math.max(0, Number(start) || 0);
    const to = Math.max(from, Number(end) || 0);
    const archived = session?.archiveFrames?.length
      ? session.archiveFrames.filter(frame => intersects(frame, from, to))
      : range.preview;
    const selected = this.ranker.select([...range.hq, ...archived], { query, subtitles: range.subtitles, limit });
    return this.#packet(range, { start, end, frames: selected });
  }

  summarize(start, end, query = "", sessionId = null) {
    const packet = this.keyframes(start, end, query, 6, sessionId);
    return { ...packet, instruction: "Summarize only from the ordered subtitles, OCR, scene markers, and selected frames. Mark uncertainty when evidence is sparse." };
  }

  archiveContext(sessionId, timestamp, before = 10, after = 10, query = "", limit = 8) {
    const session = this.resolveSession(sessionId);
    if (!session) return this.#packet({ session: null, preview: [], hq: [], subtitles: [], ocr: [], scenes: [] }, { sessionId, center: timestamp, before, after, frames: [] });
    const center = Math.max(0, Number(timestamp) || 0);
    const from = Math.max(0, center - Math.max(0, Number(before) || 0));
    const to = center + Math.max(0, Number(after) || 0);
    const preview = (session.archiveFrames || []).filter(frame => intersects(frame, from, to));
    const hq = session.hqFrames.filter(frame => intersects(frame, from, to));
    const subtitles = session.subtitles.range(from, to);
    const ocr = session.ocr.filter(item => item.timestamp >= from && item.timestamp <= to).map(item => ({ ...item }));
    const scenes = session.scenes.filter(item => item.timestamp >= from && item.timestamp <= to).map(item => ({ ...item }));
    const range = { session, preview, hq, subtitles, ocr, scenes };
    const frames = this.ranker.select([...hq, ...preview], { query, subtitles, limit });
    return this.#packet(range, { sessionId: session.id, center, before, after, frames, source: "per-video-preview-archive" });
  }

  archiveOverview(sessionId, query = "", limit = 24) {
    const session = this.resolveSession(sessionId);
    if (!session) return this.#packet({ session: null, preview: [], hq: [], subtitles: [], ocr: [], scenes: [] }, { sessionId, mode: "cached-video-overview", frames: [] });
    const preview = session.archiveFrames || [];
    const hq = session.hqFrames || [];
    const subtitles = session.subtitles.all();
    const ocr = session.ocr.map(item => ({ ...item }));
    const scenes = session.scenes.map(item => ({ ...item }));
    const range = { session, preview, hq, subtitles, ocr, scenes };
    const frames = this.ranker.select([...hq, ...preview], { query, subtitles, limit });
    const duration = Math.max(Number(session.snapshot?.duration) || 0, ...preview.map(frame => Number(frame.timestamp) || 0), ...hq.map(frame => Number(frame.timestamp) || 0), 0);
    return this.#packet(range, {
      sessionId: session.id,
      mode: "cached-video-overview",
      requested: { start: 0, end: duration },
      frames,
      source: "per-video-preview-archive",
      archiveCoverage: { frameCount: preview.length, firstTimestamp: preview[0]?.timestamp ?? null, lastTimestamp: preview.at(-1)?.timestamp ?? null }
    });
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .map(session => ({
        id: session.id,
        title: session.title || null,
        bvid: session.bvid || null,
        cid: session.cid || null,
        url: session.url || null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        duration: Number(session.snapshot?.duration) || 0,
        currentTime: Number(session.snapshot?.currentTime) || 0,
        previewFrames: session.preview.size,
        archiveFrameCount: session.archiveFrameCount || session.archiveFrames.length,
        archiveFolder: session.archiveFolder || this.archive?.sessionDirectory(session.id) || null,
        current: session.id === this.currentSessionId,
        readOnly: true
      }));
  }

  #packet(range, meta) {
    const frames = (meta.frames || []).map(frame => ({
      id: frame.id,
      timestamp: frame.timestamp,
      source: frame.source,
      width: frame.width,
      height: frame.height,
      originalWidth: frame.originalWidth,
      originalHeight: frame.originalHeight,
      previewWidth: frame.previewWidth,
      previewHeight: frame.previewHeight,
      qualityLevel: frame.qualityLevel,
      scale: frame.scale,
      scene: frame.scene,
      sceneCut: frame.sceneCut,
      ocrText: frame.ocrText,
      rankScore: frame.rankScore,
      hq: Boolean(frame.hq),
      data: frame.data || null
    }));
    return {
      ...meta,
      video: {
        id: range.session?.id || null,
        title: range.session?.title || null,
        bvid: range.session?.bvid || null,
        cid: range.session?.cid || null,
        url: range.session?.url || null
      },
      subtitles: range.subtitles,
      ocr: range.ocr,
      scenes: range.scenes,
      frames,
      frameCount: frames.length,
      readOnly: true,
      cache: {
        previewStart: range.session?.preview.start ?? null,
        previewEnd: range.session?.preview.end ?? null,
        archiveStart: range.session?.archiveFrames?.[0]?.timestamp ?? null,
        archiveEnd: range.session?.archiveFrames?.at(-1)?.timestamp ?? null,
        archiveFrameCount: range.session?.archiveFrameCount || range.session?.archiveFrames?.length || 0,
        archiveFolder: range.session?.archiveFolder || this.archive?.sessionDirectory(range.session?.id) || null,
        hqCount: range.session?.hqFrames.length || 0
      },
      missing: range.session ? [] : ["active-video-session"]
    };
  }

  async persist() {
    for (const session of this.sessions.values()) {
      if (this.archive) {
        await this.archive.saveSession(session);
      } else {
        await this.sessionStore.save({
          id: session.id,
          title: session.title,
          url: session.url,
          bvid: session.bvid,
          cid: session.cid,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          pinned: session.pinned,
          snapshot: stripSnapshotData(session.snapshot),
          hqFrames: session.hqFrames.map(({ data, ...frame }) => frame),
          preview: session.preview.range(session.preview.start ?? 0, session.preview.end ?? 0).map(({ data, ...frame }) => frame),
          subtitles: session.subtitles.all(),
          ocr: session.ocr,
          scenes: session.scenes
        });
      }
    }
  }

  async cleanup({ sessionId = null } = {}) {
    const resolved = sessionId ? this.resolveSession(sessionId) : null;
    const targetId = resolved?.id || (sessionId ? String(sessionId) : null);
    const result = this.archive
      ? await this.archive.clear(targetId)
      : { removedSessions: targetId ? [targetId] : "all" };
    if (targetId) {
      this.sessions.delete(targetId);
      this.lastArchiveAt.delete(targetId);
      if (this.currentSessionId === targetId) this.currentSessionId = null;
    } else {
      this.sessions.clear();
      this.currentSessionId = null;
      this.lastArchiveAt.clear();
    }
    return { ...result, automaticCleanup: "reboot-only", readOnly: true };
  }

  clear() {
    for (const session of this.sessions.values()) {
      session.preview.clear();
      session.hqFrames = [];
      session.subtitles.clear();
      session.ocr = [];
      session.scenes = [];
    }
  }
}
