import http from "node:http";

const MAX_BODY_BYTES = 35 * 1024 * 1024;
const DEFAULT_STALE_AFTER_MS = 3500;
const SENSITIVE_KEY = /^(cookie|cookies|localStorage|sessionStorage|sessdata|bili_jct|dedeuserid|token|authorization|access_key)$/i;

function hasSensitiveKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveKey(child));
}

function send(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600"
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let body = "";
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.setEncoding("utf8");
    request.on("data", chunk => {
      if (settled) return;
      total += Buffer.byteLength(chunk);
      if (total > MAX_BODY_BYTES) {
        fail(new RangeError("Bridge payload is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new TypeError("Bridge payload must be JSON."));
      }
    });
    request.on("aborted", () => fail(new Error("Bridge request was aborted.")));
    request.on("error", fail);
  });
}

function safeError(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/(SESSDATA|bili_jct|DedeUserID|token|cookie|authorization)[^\s]*/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function bridgeStatus({ server, index, host, port, staleAfterMs, state, version = "0.4.0" }) {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const current = index.status();
  const ageMs = state.lastObservationAt ? Math.max(0, Date.now() - Date.parse(state.lastObservationAt)) : null;
  const browserObserved = state.observationCount > 0;
  const connected = browserObserved && ageMs !== null && ageMs <= staleAfterMs;
  return {
    url: "http://" + host + ":" + actualPort,
    host,
    port: actualPort,
    version,
    listening: Boolean(address),
    connected,
    browserObserved,
    stale: !connected,
    staleAfterMs,
    startedAt: state.startedAt,
    observationCount: state.observationCount,
    lastObservationAt: state.lastObservationAt,
    lastObservationAgeMs: ageMs,
    subtitleCount: state.subtitleCount,
    lastSubtitleAt: state.lastSubtitleAt,
    lastError: state.lastError,
    activeVideo: current.bvid || current.url ? {
      bvid: current.bvid,
      cid: current.cid,
      title: current.title,
      currentTime: current.currentTime,
      duration: current.duration
    } : null,
    frame: {
      status: current.frameStatus,
      errorCode: current.frameErrorCode,
      available: current.frameAvailable,
      source: current.frameSource
    },
    readOnly: true
  };
}

export function startLoopbackBridge({ index, host = "127.0.0.1", port = 37845, staleAfterMs = DEFAULT_STALE_AFTER_MS, version = "0.4.0" } = {}) {
  if (!index) throw new TypeError("A TemporalIndex is required for the bridge.");
  const state = {
    startedAt: new Date().toISOString(),
    observationCount: 0,
    subtitleCount: 0,
    lastObservationAt: null,
    lastSubtitleAt: null,
    lastError: null
  };
  const staleWindow = Math.max(1000, Number(staleAfterMs) || DEFAULT_STALE_AFTER_MS);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://" + host);
    if (request.method === "OPTIONS") return send(response, 204, {});
    if (url.pathname === "/health" && request.method === "GET") {
      return send(response, 200, { ok: true, service: "codex-bilibili-video-observer", ...bridgeStatus({ server, index, host, port, staleAfterMs: staleWindow, state, version }) });
    }
    if (url.pathname === "/snapshot" && request.method === "GET") {
      return send(response, 200, { ...index.status(), bridge: bridgeStatus({ server, index, host, port, staleAfterMs: staleWindow, state, version }), readOnly: true });
    }
    if (request.method !== "POST" || !["/observe", "/subtitles"].includes(url.pathname)) {
      return send(response, 404, { error: "Not found." });
    }
    try {
      const payload = await readJson(request);
      if (hasSensitiveKey(payload)) {
        state.lastError = { at: new Date().toISOString(), message: "Credentials and browser storage are not accepted." };
        return send(response, 400, { error: "Credentials and browser storage are not accepted." });
      }
      const receivedAt = new Date().toISOString();
      let result;
      if (url.pathname === "/observe") {
        result = index.ingestSnapshot(payload);
        state.observationCount += 1;
        state.lastObservationAt = receivedAt;
        state.lastError = null;
      } else {
        result = { subtitleCount: index.ingestSubtitles(payload), readOnly: true };
        state.subtitleCount = result.subtitleCount;
        state.lastSubtitleAt = receivedAt;
      }
      return send(response, 200, result);
    } catch (error) {
      state.lastError = { at: new Date().toISOString(), message: safeError(error) };
      return send(response, 400, { error: safeError(error) });
    }
  });
  return new Promise((resolve, reject) => {
    const onError = error => { server.off("listening", onListening); reject(error); };
    const onListening = () => {
      server.off("error", onError);
      const actualPort = server.address().port;
      resolve({
        server,
        host,
        port: actualPort,
        url: "http://" + host + ":" + actualPort,
        status: () => bridgeStatus({ server, index, host, port: actualPort, staleAfterMs: staleWindow, state, version })
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}
