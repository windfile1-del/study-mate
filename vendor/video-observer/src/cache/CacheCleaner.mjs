export class CacheCleaner {
  constructor({ sessionTtlMs = 10 * 60 * 1000, hqTtlMs = 30 * 60 * 1000, maxBytes = 500 * 1024 * 1024 } = {}) {
    this.sessionTtlMs = sessionTtlMs;
    this.hqTtlMs = hqTtlMs;
    this.maxBytes = maxBytes;
  }

  clean(sessions = [], now = Date.now()) {
    const active = sessions.filter(session => session.pinned || now - new Date(session.updatedAt || 0).getTime() <= this.sessionTtlMs);
    const hq = [];
    let bytes = 0;
    for (const session of active) {
      for (const frame of session.hqFrames || []) {
        if (session.pinned || now - new Date(frame.cachedAt || session.updatedAt || 0).getTime() <= this.hqTtlMs) {
          hq.push({ sessionId: session.id, frame });
          bytes += Number(frame.sizeBytes) || 0;
        }
      }
    }
    hq.sort((a, b) => new Date(a.frame.cachedAt || 0) - new Date(b.frame.cachedAt || 0));
    const retained = [];
    for (const entry of hq.reverse()) {
      if (bytes <= this.maxBytes || active.find(session => session.id === entry.sessionId)?.pinned) retained.unshift(entry);
      else bytes -= Number(entry.frame.sizeBytes) || 0;
    }
    return { activeSessions: active, retainedHqFrames: retained, bytes };
  }
}
