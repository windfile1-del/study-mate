import { BrowserAdapter, extractVideoId, normalizeSnapshot } from "./BrowserAdapter.mjs";

export function isBilibiliUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv";
  } catch {
    return false;
  }
}

export class BilibiliBrowserAdapter extends BrowserAdapter {
  ingestSnapshot(raw) {
    const snapshot = normalizeSnapshot(raw);
    if (snapshot.url && !isBilibiliUrl(snapshot.url)) {
      throw new TypeError("The observed page is not a Bilibili URL.");
    }
    const ids = extractVideoId(snapshot.url);
    return super.ingestSnapshot({
      ...snapshot,
      bvid: snapshot.bvid || ids.bvid,
      cid: snapshot.cid || ids.cid
    });
  }

  async readFromBridge() {
    const snapshot = await super.readFromBridge();
    if (snapshot?.url && !isBilibiliUrl(snapshot.url)) {
      throw new TypeError("The browser bridge is not observing a Bilibili page.");
    }
    return snapshot;
  }
}
