(function installCodexBilibiliVideoObserver(global) {
  "use strict";

  var DEFAULT_ENDPOINT = "http://127.0.0.1:37845/observe";
  var PREVIEW_MAX_WIDTH = 960;
  var PREVIEW_MAX_HEIGHT = 540;
  var PREVIEW_WEBP_QUALITY = 0.78;
  var timer = null;
  var endpoint = DEFAULT_ENDPOINT;
  var subtitleEndpoint = DEFAULT_ENDPOINT.replace(/\/observe(?:$|\?)/, "/subtitles");
  var intervalMs = 1000;
  var frameIntervalMs = 15000;
  var includeFrame = true;
  var includeSubtitles = true;
  var lastFrameSentAt = 0;
  var lastFramePageKey = null;
  var lastSubtitleText = null;
  var lastSubtitleAt = null;
  var state = {
    running: false,
    paused: false,
    endpoint: DEFAULT_ENDPOINT,
    subtitleEndpoint: subtitleEndpoint,
    intervalMs: intervalMs,
    frameIntervalMs: frameIntervalMs,
    includeFrame: true,
    includeSubtitles: true,
    sentCount: 0,
    subtitleSentCount: 0,
    lastSentAt: null,
    lastSubtitleSentAt: null,
    lastSubtitleText: null,
    lastSubtitleError: null,
    lastFrameSentAt: null,
    lastError: null
  };

  function isBilibiliPage() {
    var host = String(global.location && global.location.hostname || "").toLowerCase();
    return host === "bilibili.com" || host.slice(-".bilibili.com".length) === ".bilibili.com" || host === "b23.tv";
  }

  function listVideos() {
    return Array.prototype.slice.call(global.document.querySelectorAll("video"));
  }

  function findVideo(videos) {
    return videos.slice().sort(function (a, b) {
      return (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight);
    })[0] || null;
  }

  function errorCode(error) {
    var name = String(error && error.name || "").toLowerCase();
    var message = String(error && error.message || "").toLowerCase();
    if (name === "securityerror" || message.indexOf("taint") >= 0 || message.indexOf("cross-origin") >= 0) return "canvas-security";
    if (message.indexOf("not allowed") >= 0 || message.indexOf("permission") >= 0) return "canvas-permission";
    return "canvas-capture-failed";
  }

  function errorMessage(error) {
    return String(error && error.message || error || "Unknown observer error")
      .replace(/(sessdata|bili_jct|dedeuserid|token|cookie|authorization)[^\s]*/ig, "$1=[REDACTED]")
      .slice(0, 240);
  }

  function unavailableFrame(video, status, code) {
    return {
      timestamp: Number(video.currentTime) || 0,
      width: Number(video.videoWidth) || 0,
      height: Number(video.videoHeight) || 0,
      originalWidth: Number(video.videoWidth) || 0,
      originalHeight: Number(video.videoHeight) || 0,
      qualityLevel: "preview",
      scale: 1,
      mimeType: "image/webp",
      source: "canvas",
      status: status,
      errorCode: code || null,
      data: null
    };
  }

  function copyCurrentFrame(video) {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return unavailableFrame(video, "not-ready", "video-not-ready");
    }
    try {
      var originalWidth = Math.max(1, Number(video.videoWidth) || 1);
      var originalHeight = Math.max(1, Number(video.videoHeight) || 1);
      var scale = Math.min(1, PREVIEW_MAX_WIDTH / originalWidth, PREVIEW_MAX_HEIGHT / originalHeight);
      var width = Math.max(1, Math.round(originalWidth * scale));
      var height = Math.max(1, Math.round(originalHeight * scale));
      var canvas = global.document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext("2d");
      if (!context) return unavailableFrame(video, "unavailable", "canvas-context-unavailable");
      context.drawImage(video, 0, 0, width, height);
      var data = canvas.toDataURL("image/webp", PREVIEW_WEBP_QUALITY);
      return {
        timestamp: Number(video.currentTime) || 0,
        width: width,
        height: height,
        originalWidth: originalWidth,
        originalHeight: originalHeight,
        qualityLevel: "preview",
        scale: scale,
        mimeType: "image/webp",
        source: "canvas",
        status: data ? "captured" : "empty",
        errorCode: data ? null : "canvas-empty",
        data: data || null
      };
    } catch (error) {
      return unavailableFrame(video, "unavailable", errorCode(error));
    }
  }

  function visibleSubtitleText() {
    var selectors = [
      ".bili-subtitle-x-subtitle-panel-text",
      ".bpx-player-subtitle-wrap"
    ];
    for (var s = 0; s < selectors.length; s += 1) {
      var nodes = global.document.querySelectorAll(selectors[s]);
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        var text = String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 5000);
        if (!text) continue;
        var rect = node.getBoundingClientRect();
        var style = global.getComputedStyle ? global.getComputedStyle(node) : null;
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) continue;
        return text;
      }
    }
    return null;
  }

  function subtitlePayload(video) {
    var text = visibleSubtitleText();
    if (!text) {
      lastSubtitleText = null;
      lastSubtitleAt = null;
      state.lastSubtitleText = null;
      return null;
    }
    var timestamp = Number(video.currentTime) || 0;
    var sameCaption = text === lastSubtitleText && lastSubtitleAt !== null && Math.abs(timestamp - lastSubtitleAt) < 3;
    if (sameCaption) return null;
    lastSubtitleText = text;
    lastSubtitleAt = timestamp;
    state.lastSubtitleText = text;
    return {
      source: "bilibili-ai-visible",
      entries: [{ from: timestamp, to: timestamp + 2.5, text: text, source: "bilibili-ai-visible" }],
      readOnly: true
    };
  }

  function sendVisibleSubtitle() {
    if (!includeSubtitles) return Promise.resolve(null);
    var video = findVideo(listVideos());
    if (!video) return Promise.resolve(null);
    var payload = subtitlePayload(video);
    if (!payload) return Promise.resolve(null);
    return global.fetch(subtitleEndpoint, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (response) {
      if (!response.ok) throw new Error("Subtitle bridge returned HTTP " + response.status + ".");
      return response.json();
    }).then(function (result) {
      state.subtitleSentCount += 1;
      state.lastSubtitleSentAt = new Date().toISOString();
      state.lastSubtitleError = null;
      return result;
    }).catch(function (error) {
      state.lastSubtitleError = { at: new Date().toISOString(), code: "subtitle-bridge-request-failed", message: errorMessage(error) };
      return null;
    });
  }

  function snapshot(options) {
    if (!isBilibiliPage()) throw new Error("The current page is not Bilibili.");
    var videos = listVideos();
    var video = findVideo(videos);
    if (!video) throw new Error("No HTML video element is available.");
    var rect = video.getBoundingClientRect();
    var frame = options && options.includeFrame === false ? null : copyCurrentFrame(video);
    return {
      url: String(global.location.href),
      title: String(global.document.title || "").slice(0, 500),
      observedAt: new Date().toISOString(),
      videoElementCount: videos.length,
      videoReadyState: Number(video.readyState) || 0,
      currentTime: Number(video.currentTime) || 0,
      duration: Number(video.duration) || 0,
      videoWidth: Number(video.videoWidth) || 0,
      videoHeight: Number(video.videoHeight) || 0,
      paused: Boolean(video.paused),
      playbackRate: Number(video.playbackRate) || 1,
      volume: Number(video.volume),
      videoRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      frame: frame,
      frameStatus: frame ? frame.status : "not-requested",
      frameErrorCode: frame ? frame.errorCode : null
    };
  }

  function pageKey() {
    return String(global.location && global.location.href || "").split("#")[0];
  }

  function frameIsDue() {
    return lastFramePageKey !== pageKey() || !lastFrameSentAt || Date.now() - lastFrameSentAt >= frameIntervalMs;
  }

  function markFrameSent() {
    lastFrameSentAt = Date.now();
    lastFramePageKey = pageKey();
    state.lastFrameSentAt = new Date(lastFrameSentAt).toISOString();
  }

  function send(options) {
    var payload;
    try {
      payload = snapshot(options || {});
    } catch (error) {
      state.lastError = { at: new Date().toISOString(), code: "snapshot-failed", message: errorMessage(error) };
      return Promise.reject(error);
    }
    return global.fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (response) {
      if (!response.ok) throw new Error("Observer bridge returned HTTP " + response.status + ".");
      return response.json();
    }).then(function (result) {
      state.sentCount += 1;
      state.lastSentAt = new Date().toISOString();
      state.lastError = null;
      return sendVisibleSubtitle().then(function () { return result; });
    }).catch(function (error) {
      state.lastError = { at: new Date().toISOString(), code: "bridge-request-failed", message: errorMessage(error) };
      throw error;
    });
  }

  function sendTick() {
    var captureFrame = includeFrame && frameIsDue();
    return send({ includeFrame: captureFrame }).then(function () {
      if (captureFrame) markFrameSent();
    });
  }

  function schedule() {
    if (timer !== null) global.clearInterval(timer);
    timer = global.setInterval(function () {
      sendTick().catch(function () {});
    }, intervalMs);
  }

  function start(options) {
    options = options || {};
    stop();
    endpoint = String(options.endpoint || DEFAULT_ENDPOINT);
    subtitleEndpoint = String(options.subtitleEndpoint || endpoint.replace(/\/observe(?:$|\?)/, "/subtitles"));
    intervalMs = Math.max(500, Number(options.intervalMs) || 1000);
    frameIntervalMs = Math.min(20000, Math.max(10000, Number(options.frameIntervalMs) || 15000));
    includeFrame = options.includeFrame !== false;
    includeSubtitles = options.includeSubtitles !== false;
    lastSubtitleText = null;
    lastSubtitleAt = null;
    lastFrameSentAt = 0;
    lastFramePageKey = null;
    state.running = true;
    state.paused = false;
    state.endpoint = endpoint;
    state.subtitleEndpoint = subtitleEndpoint;
    state.intervalMs = intervalMs;
    state.frameIntervalMs = frameIntervalMs;
    state.includeFrame = includeFrame;
    state.includeSubtitles = includeSubtitles;
    state.lastSubtitleError = null;
    var initialFrame = includeFrame;
    send({ includeFrame: initialFrame }).then(function () {
      if (initialFrame) markFrameSent();
    }).catch(function () {});
    schedule();
    return { endpoint: endpoint, subtitleEndpoint: subtitleEndpoint, intervalMs: intervalMs, frameIntervalMs: frameIntervalMs, includeFrame: includeFrame, includeSubtitles: includeSubtitles, readOnly: true };
  }

  function pause() {
    if (timer !== null) global.clearInterval(timer);
    timer = null;
    if (!state.running && !state.paused) return { paused: false, reason: "observer-not-running", readOnly: true };
    state.running = false;
    state.paused = true;
    return { paused: true, readOnly: true };
  }

  function resume() {
    if (!state.paused) return { resumed: false, reason: state.running ? "observer-already-running" : "observer-not-paused", readOnly: true };
    state.running = true;
    state.paused = false;
    sendTick().catch(function () {});
    schedule();
    return { resumed: true, readOnly: true };
  }

  function stop() {
    if (timer !== null) global.clearInterval(timer);
    timer = null;
    state.running = false;
    state.paused = false;
    return { stopped: true, readOnly: true };
  }

  function diagnostics() {
    return { ...state, readOnly: true };
  }

  global.__codexBilibiliVideoObserver = Object.freeze({
    snapshot: snapshot,
    send: send,
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    diagnostics: diagnostics,
    readOnly: true
  });
})(globalThis);
