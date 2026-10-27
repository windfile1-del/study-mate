import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundledYtDlp = path.join(pluginRoot, "tools", "windows-x64", "yt-dlp.exe");
const bundledFfmpeg = path.join(pluginRoot, "tools", "windows-x64", "ffmpeg", "bin", "ffmpeg.exe");
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT = 8_000_000;
const EXTRACTION_CONCURRENCY = 4;
export const MAX_BACKFILL_FRAMES = 96;
export const MAX_OVERVIEW_FRAMES = 96;
const SAFE_HEADER_NAMES = new Set(["accept", "accept-language", "referer", "user-agent"]);
const BILIBILI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/"
};

function commandName(value, fallback) {
  return String(value || fallback);
}

function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutput = MAX_COMMAND_OUTPUT } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ ok: false, code: null, stdout: Buffer.alloc(0), stderr: "spawn-failed", error });
      return;
    }

    child.stdout.on("data", chunk => {
      if (stdoutBytes < maxOutput) {
        const value = Buffer.from(chunk);
        stdout.push(value.subarray(0, Math.max(0, maxOutput - stdoutBytes)));
        stdoutBytes += value.length;
      }
    });
    child.stderr.on("data", chunk => {
      if (stderrBytes < 16_000) {
        const value = Buffer.from(chunk).toString("utf8");
        stderr.push(value.slice(0, Math.max(0, 16_000 - stderrBytes)));
        stderrBytes += value.length;
      }
    });
    child.on("error", error => finish({ ok: false, code: null, stdout: Buffer.concat(stdout), stderr: "process-error", error }));
    child.on("close", code => finish({ ok: code === 0, code, stdout: Buffer.concat(stdout), stderr: stderr.join("") }));
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, code: null, stdout: Buffer.concat(stdout), stderr: "timeout", timedOut: true });
    }, timeoutMs);
  });
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.round(timestamp * 1000) / 1000) : null;
}

export function sampleTimestamps(start, end, { maxFrames = MAX_BACKFILL_FRAMES } = {}) {
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  const count = Math.min(MAX_BACKFILL_FRAMES, Math.max(1, Math.floor(Number(maxFrames) || MAX_BACKFILL_FRAMES)));
  if (count === 1 || to === from) return [Math.round(from * 1000) / 1000];
  return Array.from({ length: count }, (_, index) => Math.round((from + ((to - from) * index) / (count - 1)) * 1000) / 1000);
}

export function sampleOverviewTimestamps(start, end, { maxFrames = MAX_OVERVIEW_FRAMES } = {}) {
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  const count = Math.min(MAX_OVERVIEW_FRAMES, Math.max(1, Math.floor(Number(maxFrames) || MAX_OVERVIEW_FRAMES)));
  if (count === 1 || to === from) return [Math.round(from * 1000) / 1000];
  return Array.from({ length: count }, (_, index) => Math.round((from + ((to - from) * index) / (count - 1)) * 1000) / 1000);
}

export function chooseDynamicFrameCount(duration, { minimum = 12, maximum = MAX_OVERVIEW_FRAMES, framesPerMinute = 1 } = {}) {
  const seconds = Math.max(0, Number(duration) || 0);
  const floor = Math.max(1, Math.floor(Number(minimum) || 1));
  const ceiling = Math.max(floor, Math.floor(Number(maximum) || MAX_OVERVIEW_FRAMES));
  const density = Math.max(0.1, Number(framesPerMinute) || 1);
  return Math.min(ceiling, Math.max(floor, Math.ceil((seconds / 60) * density)));
}

function safeHeaders(headers = {}) {
  return Object.entries(headers)
    .filter(([name, value]) => SAFE_HEADER_NAMES.has(String(name).toLowerCase()) && value != null)
    .map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]/g, " ")}`)
    .join("\r\n");
}

async function resolveWithYtDlp(url, { ytDlp = bundledYtDlp, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = await runCommand(commandName(ytDlp, "yt-dlp"), [
    "--no-warnings",
    "--no-cache-dir",
    "--no-playlist",
    "--skip-download",
    "--dump-single-json",
    "--format", "best[protocol^=http][ext=mp4]/best[ext=mp4]/best",
    String(url)
  ], { timeoutMs });
  if (!result.ok) throw new Error("yt-dlp could not resolve a playable media stream.");

  let metadata = null;
  for (const line of result.stdout.toString("utf8").trim().split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      metadata = JSON.parse(line);
      break;
    } catch {}
  }
  const mediaUrl = metadata?.url || metadata?.requested_downloads?.[0]?.url;
  if (!mediaUrl) throw new Error("yt-dlp returned no playable media stream.");
  return {
    url: String(mediaUrl),
    headers: metadata.http_headers || {},
    width: Math.max(0, Number(metadata.width) || 0),
    height: Math.max(0, Number(metadata.height) || 0),
    duration: Math.max(0, Number(metadata.duration) || 0)
  };
}

function bilibiliVideoId(url) {
  try {
    const parsed = new URL(String(url));
    const match = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: BILIBILI_HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error("Bilibili API returned an HTTP error.");
    const payload = await response.json();
    if (payload?.code !== 0) throw new Error("Bilibili API returned an error.");
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWithBilibiliApi(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bvid = bilibiliVideoId(url);
  if (!bvid) throw new Error("The URL does not contain a Bilibili BV identifier.");
  const parsedUrl = new URL(url);
  const requestedCid = parsedUrl.searchParams.get("cid");
  const pageNumber = Math.max(1, Number(parsedUrl.searchParams.get("p")) || 1);
  const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { timeoutMs });
  const page = Array.isArray(view?.pages)
    ? (requestedCid && !parsedUrl.searchParams.has("p")
      ? (view.pages.find(item => String(item.cid) === String(requestedCid)) || view.pages[0])
      : (view.pages.find(item => Number(item.page) === pageNumber) || view.pages[0]))
    : null;
  if (!page?.cid) throw new Error("Bilibili returned no playable page metadata.");
  const play = await fetchJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(page.cid)}&qn=80&fnver=0&fnval=0&fourk=1`, { timeoutMs });
  const durl = Array.isArray(play?.durl) ? play.durl[0] : null;
  const dash = Array.isArray(play?.dash?.video) ? play.dash.video[0] : null;
  const mediaUrl = durl?.url || durl?.backup_url?.[0] || dash?.baseUrl || dash?.base_url;
  if (!mediaUrl) throw new Error("Bilibili returned no playable media stream.");
  return {
    url: String(mediaUrl),
    headers: BILIBILI_HEADERS,
    width: Math.max(0, Number(durl?.width || dash?.width) || 0),
    height: Math.max(0, Number(durl?.height || dash?.height) || 0),
    duration: Math.max(0, Number(view?.duration) || 0),
    resolver: "bilibili-api",
    page: pageNumber,
    cid: String(page.cid)
  };
}

async function resolveMediaMetadata(url, options = {}) {
  try {
    return await resolveWithYtDlp(url, options);
  } catch (ytDlpError) {
    try {
      return await resolveWithBilibiliApi(url, options);
    } catch {
      throw ytDlpError;
    }
  }
}

async function extractFrameAt({ media, timestamp, ffmpeg = bundledFfmpeg, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const headers = safeHeaders(media.headers);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(timestamp),
    ...(headers ? ["-headers", headers] : []),
    "-i", media.url,
    "-frames:v", "1",
    "-an",
    "-f", "image2pipe",
    "-c:v", "mjpeg",
    "-q:v", "3",
    "pipe:1"
  ];
  const result = await runCommand(commandName(ffmpeg, "ffmpeg"), args, { timeoutMs, maxOutput: 30_000_000 });
  if (!result.ok || !result.stdout.length) throw new Error("FFmpeg could not decode the requested frame.");
  return {
    data: result.stdout,
    width: media.width,
    height: media.height,
    mimeType: "image/jpeg"
  };
}

export async function probeMediaTools({ ytDlp = process.env.BILIBILI_OBSERVER_YTDLP_BIN || bundledYtDlp, ffmpeg = process.env.BILIBILI_OBSERVER_FFMPEG_BIN || bundledFfmpeg } = {}) {
  const [yt, ff] = await Promise.all([
    runCommand(commandName(ytDlp, "yt-dlp"), ["--version"], { timeoutMs: 10_000, maxOutput: 4_000 }),
    runCommand(commandName(ffmpeg, "ffmpeg"), ["-version"], { timeoutMs: 10_000, maxOutput: 4_000 })
  ]);
  return {
    ytDlp: { available: yt.ok, command: commandName(ytDlp, "yt-dlp"), version: yt.stdout.toString("utf8").trim().split(/\r?\n/)[0] || null },
    ffmpeg: { available: ff.ok, command: commandName(ffmpeg, "ffmpeg"), version: ff.stdout.toString("utf8").trim().split(/\r?\n/)[0] || null },
    enabled: process.env.BILIBILI_OBSERVER_ENABLE_MEDIA_FETCH === "1"
  };
}

export async function planBackfill({ start, end, url, tools }) {
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  const media = tools || await probeMediaTools();
  const available = Boolean(media.ytDlp?.available && media.ffmpeg?.available);
  const enabled = Boolean(media.enabled);
  return {
    requested: { start: from, end: to },
    url: url || null,
    available,
    enabled,
    action: !enabled ? "metadata-only" : !available ? "media-tools-unavailable" : "background-extraction-available",
    reason: !enabled
      ? "Media fetching is opt-in; set BILIBILI_OBSERVER_ENABLE_MEDIA_FETCH=1 to enable background extraction."
      : !available
        ? "yt-dlp and FFmpeg are not both available; no player control or network fallback was attempted."
        : "Background extraction uses local yt-dlp and FFmpeg and never seeks, pauses, or changes the foreground player."
  };
}

export async function extractFrames({
  url,
  timestamps,
  media,
  ytDlp,
  ffmpeg,
  width = 0,
  height = 0,
  maxFrames = MAX_BACKFILL_FRAMES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resolveMedia = resolveMediaMetadata,
  extractFrame = extractFrameAt
} = {}) {
  const frameLimit = Math.min(MAX_OVERVIEW_FRAMES, Math.max(1, Math.floor(Number(maxFrames) || MAX_BACKFILL_FRAMES)));
  const requestedTimestamps = [...new Set((Array.isArray(timestamps) ? timestamps : []).map(normalizeTimestamp).filter(value => value != null))].slice(0, frameLimit);
  const tools = media || await probeMediaTools({ ytDlp, ffmpeg });
  const base = await planBackfill({ start: requestedTimestamps[0] || 0, end: requestedTimestamps.at(-1) || requestedTimestamps[0] || 0, url, tools });
  const result = { ...base, mode: "background-ffmpeg", frames: [], failures: [], extractedFrameCount: 0, readOnly: true };
  if (!url) return { ...result, action: "no-active-video", reason: "No active Bilibili video URL is indexed." };
  if (!tools.enabled || !base.available) return result;

  let playable;
  try {
    playable = await resolveMedia(url, { ytDlp: ytDlp || tools.ytDlp?.command || bundledYtDlp, timeoutMs });
  } catch {
    return { ...result, action: "failed", reason: "yt-dlp could not resolve the active Bilibili video.", errorCode: "media-resolve-failed" };
  }

  let cursor = 0;
  async function worker() {
    while (cursor < requestedTimestamps.length) {
      const timestamp = requestedTimestamps[cursor++];
      try {
        const frame = await extractFrame({ media: playable, timestamp, ffmpeg: ffmpeg || tools.ffmpeg?.command || bundledFfmpeg, timeoutMs });
        result.frames.push({
          timestamp,
          width: frame.width || playable.width || width || 0,
          height: frame.height || playable.height || height || 0,
          source: "ffmpeg",
          status: "captured",
          mimeType: frame.mimeType || "image/jpeg",
          data: Buffer.isBuffer(frame.data) ? frame.data.toString("base64") : String(frame.data || ""),
          metrics: { hq: true, backfill: true },
          hq: true
        });
      } catch {
        result.failures.push({ timestamp, errorCode: "frame-extraction-failed" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EXTRACTION_CONCURRENCY, requestedTimestamps.length) }, () => worker()));
  result.frames.sort((a, b) => a.timestamp - b.timestamp);
  result.failures.sort((a, b) => a.timestamp - b.timestamp);
  result.extractedFrameCount = result.frames.length;
  result.action = result.frames.length ? "completed" : "failed";
  if (!result.frames.length) result.reason = "FFmpeg could not decode any requested timestamp.";
  return result;
}
