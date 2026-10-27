import { SubtitleTimeline, normalizeSubtitle } from "./SubtitleTimeline.mjs";

export class BilibiliSubtitleAdapter {
  ingest(payload = {}) {
    const timeline = new SubtitleTimeline();
    const source = payload.source || (payload.ai ? "bilibili-ai" : "bilibili");
    if (typeof payload.srt === "string") timeline.addSrt(payload.srt, source);
    const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.body) ? payload.body : Array.isArray(payload.data) ? payload.data : [];
    if (entries.length) timeline.add(entries.map(item => normalizeSubtitle({ ...item, source })), source);
    return timeline.all();
  }

  normalizeAiSubtitle(entries) {
    return (Array.isArray(entries) ? entries : []).map(item => normalizeSubtitle({
      from: item.from ?? item.start ?? item.start_time,
      to: item.to ?? item.end ?? item.end_time,
      text: item.content ?? item.text,
      confidence: item.confidence,
      source: "bilibili-ai"
    })).filter(item => item.text);
  }
}
