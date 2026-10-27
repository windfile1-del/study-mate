import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_DATA_DIR = process.env.BILIBILI_OBSERVER_DATA_DIR || path.join(os.tmpdir(), "codex-bilibili-video-observer");
const MAX_FRAME_BYTES = 30 * 1024 * 1024;

function safeSegment(value) {
  const result = String(value || "session").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return result || "session";
}

function bootIdFromSystem(now = Date.now(), uptimeSeconds = os.uptime()) {
  // os.uptime() and Date.now() are sampled a few milliseconds apart. Bucket
  // the derived boot epoch so a normal process restart cannot look like a
  // reboot merely because it crossed a wall-clock second boundary.
  return String(Math.round((Number(now) - (Number(uptimeSeconds) * 1000)) / 60_000));
}

function framePayload(data) {
  if (Buffer.isBuffer(data)) return data;
  const value = String(data || "");
  const comma = value.indexOf(",");
  const encoded = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) return null;
  const payload = Buffer.from(encoded, "base64");
  return payload.length > 0 && payload.length <= MAX_FRAME_BYTES ? payload : null;
}

function extensionForMime(mimeType) {
  const mime = String(mimeType || "image/webp").toLowerCase();
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  return "webp";
}

function stripFrameData(frame = {}) {
  const { data, ...metadata } = frame;
  return metadata;
}

function stripSnapshotData(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot || null;
  return {
    ...snapshot,
    frame: snapshot.frame ? stripFrameData(snapshot.frame) : snapshot.frame || null
  };
}

function asFileUrl(root, value) {
  const relative = String(value || "").replace(/\\/g, "/");
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  return target === resolvedRoot || target.startsWith(`${resolvedRoot}${path.sep}`) ? target : null;
}

async function atomicWrite(target, content, encoding = undefined) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  await fs.writeFile(temporary, content, encoding);
  await fs.rename(temporary, target);
}

export class FrameArchive {
  constructor(dataDir = DEFAULT_DATA_DIR, { bootIdProvider = bootIdFromSystem, clearOnReboot = true, maxFrames = 2400, maxBytes = 96*1024*1024 } = {}) {
    this.dataDir = path.resolve(String(dataDir));
    this.videosDir = path.join(this.dataDir, "videos");
    this.bootMarker = path.join(this.dataDir, ".boot-id");
    this.bootIdProvider = bootIdProvider;
    this.clearOnReboot = clearOnReboot;
    this.bootId = null;
    this.initialized = false;
    this.rebootCleanup = false;
    this.lastError = null;
    this.queues = new Map();
    this.maxFrames=maxFrames;this.maxBytes=maxBytes;
  }

  sessionDirectory(id) {
    return path.join(this.videosDir, safeSegment(id));
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const currentBootId = String(this.bootIdProvider());
    let previousBootId = null;
    try {
      previousBootId = (await fs.readFile(this.bootMarker, "utf8")).trim() || null;
    } catch {
      // A missing marker is the first run. Preserve any manually placed data.
    }
    if (this.clearOnReboot && previousBootId && previousBootId !== currentBootId) {
      const scopedTarget = path.resolve(this.videosDir);
      const scopedParent = path.resolve(this.dataDir);
      if (scopedTarget === scopedParent || !scopedTarget.startsWith(`${scopedParent}${path.sep}`)) {
        throw new Error("Refusing to clear an archive outside its configured data directory.");
      }
      await fs.rm(scopedTarget, { recursive: true, force: true });
      this.rebootCleanup = true;
    }
    await fs.mkdir(this.videosDir, { recursive: true });
    await atomicWrite(this.bootMarker, currentBootId, "utf8");
    this.bootId = currentBootId;
    this.initialized = true;
    return { dataDir: this.dataDir, videosDir: this.videosDir, bootId: currentBootId, rebootCleanup: this.rebootCleanup };
  }

  async #ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  #enqueue(sessionId, operation) {
    const key = String(sessionId || "session");
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tracked = next.finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key);
    });
    this.queues.set(key, tracked);
    return next;
  }

  async saveSession(session) {
    if (!session?.id) return null;
    return this.#enqueue(session.id, async () => {
      await this.#ensureInitialized();
      const directory = this.sessionDirectory(session.id);
      await fs.mkdir(directory, { recursive: true });
      const value = {
        id: session.id,
        title: session.title || null,
        url: session.url || null,
        bvid: session.bvid || null,
        cid: session.cid || null,
        createdAt: session.createdAt || new Date().toISOString(),
        updatedAt: session.updatedAt || new Date().toISOString(),
        pinned: session.pinned !== false,
        snapshot: stripSnapshotData(session.snapshot),
        hqFrames: (session.hqFrames || []).map(stripFrameData),
        subtitles: session.subtitles?.all ? session.subtitles.all() : (session.subtitles || []),
        ocr: session.ocr || [],
        scenes: session.scenes || [],
        archiveFolder: directory,
        archiveFrameCount: Number(session.archiveFrameCount) || (session.archiveFrames || []).length || 0,
        schemaVersion: 1
      };
      await atomicWrite(path.join(directory, "session.json"), JSON.stringify(value, null, 2), "utf8");
      return directory;
    });
  }

  async archiveFrame(session, frame, kind = "preview") {
    if (!session?.id || !frame?.data) return { archived: false, reason: "no-frame-data" };
    return this.#enqueue(session.id, async () => {
      await this.#ensureInitialized();
      const payload = framePayload(frame.data);
      if (!payload) return { archived: false, reason: "invalid-frame-data" };
      const folderName = kind === "hq" ? "hq" : "preview";
      const directory = path.join(this.sessionDirectory(session.id), folderName);
      await fs.mkdir(directory, { recursive: true });
      const timestamp = Math.max(0, Number(frame.timestamp) || 0);
      const digest = crypto.createHash("sha1").update(`${session.id}|${kind}|${timestamp}|${frame.source || "frame"}`).digest("hex").slice(0, 10);
      const baseName = `${String(Math.round(timestamp * 1000)).padStart(12, "0")}-${digest}`;
      const extension = extensionForMime(frame.mimeType);
      const fileName = `${baseName}.${extension}`;
      const target = path.join(directory, fileName);
      const relativePath = path.relative(this.dataDir, target).split(path.sep).join("/");
      const metadata = {
        ...stripFrameData(frame),
        archivePath: relativePath,
        archiveKind: folderName,
        archivedAt: new Date().toISOString(),
        sizeBytes: payload.length
      };
      try {
        await fs.access(target);
      } catch {
        await fs.writeFile(target, payload);
      }
      await atomicWrite(`${target}.json`, JSON.stringify(metadata, null, 2), "utf8");
      session.archiveFrames=(session.archiveFrames||[]).map(f=>f.id===frame.id?{...f,...metadata,data:null}:f);
      let size=session.archiveFrames.reduce((n,f)=>n+(f.sizeBytes||0),0);
      while(session.archiveFrames.length>this.maxFrames||size>this.maxBytes){
        const old=session.archiveFrames.shift();size-=old.sizeBytes||0;
        const oldPath=asFileUrl(this.dataDir,old.archivePath||'');
        if(oldPath&&oldPath.startsWith(this.videosDir+path.sep)&&oldPath!==this.videosDir){await fs.rm(oldPath,{force:true});await fs.rm(oldPath+'.json',{force:true});}
      }
      session.archiveFrameCount=session.archiveFrames.length;
      return { archived: true, path: target, relativePath, sizeBytes: payload.length, metadata };
    });
  }

  async #loadFrameMetadata(metadataPath, { includeData = true } = {}) {
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    } catch {
      return null;
    }
    const dataPath = asFileUrl(this.dataDir, metadata.archivePath);
    if (!dataPath) return null;
    if (!includeData) return { ...metadata, data: null, archivePath: dataPath };
    try {
      const data = (await fs.readFile(dataPath)).toString("base64");
      return { ...metadata, data, archivePath: dataPath };
    } catch {
      return null;
    }
  }

  async loadSession(directory, { includeData = true } = {}) {
    const sessionPath = path.join(directory, "session.json");
    let session;
    try {
      session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
    } catch {
      return null;
    }
    const previewDirectory = path.join(directory, "preview");
    let previewFrames = [];
    try {
      const names = (await fs.readdir(previewDirectory)).filter(name => name.endsWith(".json")).sort();
      previewFrames = (await Promise.all(names.map(name => this.#loadFrameMetadata(path.join(previewDirectory, name), { includeData })))).filter(Boolean);
    } catch {
      previewFrames = [];
    }
    return {
      ...session,
      archiveFolder: directory,
      archiveFrames: previewFrames,
      archiveFrameCount: previewFrames.length,
      archiveDataHydrated: includeData
    };
  }

  async listSessions({ includeData = true } = {}) {
    await this.#ensureInitialized();
    let names;
    try {
      names = await fs.readdir(this.videosDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const sessions = [];
    for (const entry of names.filter(item => item.isDirectory())) {
      const value = await this.loadSession(path.join(this.videosDir, entry.name), { includeData });
      if (value) sessions.push(value);
    }
    return sessions.sort((a, b) => new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime());
  }

  async loadFrames(id, { start = 0, end = Number.POSITIVE_INFINITY, includeData = true } = {}) {
    await this.#ensureInitialized();
    const directory = path.join(this.sessionDirectory(id), "preview");
    const from = Math.max(0, Number(start) || 0);
    const to = Math.max(from, Number(end) || 0);
    let names;
    try {
      names = (await fs.readdir(directory)).filter(name => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const frames = [];
    for (const name of names) {
      const metadata = await this.#loadFrameMetadata(path.join(directory, name), { includeData: false });
      if (!metadata || metadata.timestamp < from || metadata.timestamp > to) continue;
      if (includeData) {
        try {
          metadata.data = (await fs.readFile(metadata.archivePath)).toString("base64");
        } catch {
          continue;
        }
      }
      frames.push(metadata);
    }
    return frames;
  }

  async readFrame(frame){
    const file=asFileUrl(this.dataDir,frame.archivePath||'');
    if(!file||!file.startsWith(this.videosDir+path.sep)||! /\.(webp|png|jpg)$/.test(file))return null;
    try{const actual=await fs.realpath(file);if(!actual.startsWith(this.videosDir+path.sep))return null;return{...frame,data:(await fs.readFile(actual)).toString('base64')};}catch{return null;}
  }

  async clear(sessionId = null) {
    await this.#ensureInitialized();
    if (sessionId) {
      const target = this.sessionDirectory(sessionId);
      await fs.rm(target, { recursive: true, force: true });
      return { removedSessions: [String(sessionId)] };
    }
    await fs.rm(this.videosDir, { recursive: true, force: true });
    await fs.mkdir(this.videosDir, { recursive: true });
    return { removedSessions: "all" };
  }

  status(session = null) {
    return {
      enabled: true,
      dataDir: this.dataDir,
      videosDir: this.videosDir,
      folder: session?.id ? this.sessionDirectory(session.id) : null,
      bootId: this.bootId,
      rebootCleanup: this.rebootCleanup,
      frameIntervalMs: 15_000,
      frameCount: Number(session?.archiveFrameCount) || (session?.archiveFrames || []).length || 0,
      readOnlyPlayback: true
    };
  }
}

export { bootIdFromSystem, safeSegment };
