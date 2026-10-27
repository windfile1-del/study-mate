export function normalizeSubtitle(entry = {}) {
  const from = Math.max(0, Number(entry.from ?? entry.start ?? entry.startTime) || 0);
  const to = Math.max(from, Number(entry.to ?? entry.end ?? entry.endTime) || from);
  const text = String(entry.text ?? entry.content ?? "").replace(/\s+/g, " ").trim();
  return { from, to, text, source: String(entry.source || "unknown"), confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null };
}

export function parseSrt(srt = "", source = "srt") {
  const blocks = String(srt).replace(/\r/g, "").split(/\n{2,}/);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex(line => line.includes(" --> "));
    if (timingIndex < 0) continue;
    const [start, end] = lines[timingIndex].split(" --> ").map(parseSubtitleTime);
    const text = lines.slice(timingIndex + 1).join(" ");
    if (text) entries.push(normalizeSubtitle({ from: start, to: end, text, source }));
  }
  return entries;
}

function parseSubtitleTime(value) {
  const match = String(value).match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export class SubtitleTimeline {
  #entries = [];
  #keys = new Set();

  add(entries, source = "unknown") {
    const values = Array.isArray(entries) ? entries : [entries];
    for (const raw of values) {
      const item = normalizeSubtitle({ ...raw, source: raw?.source || source });
      if (!item.text) continue;
      const key=JSON.stringify([item.from,item.to,item.text,item.source]);
      if(!this.#keys.has(key)){this.#entries.push(item);this.#keys.add(key);}
    }
    this.#entries.sort((a, b) => a.from - b.from || a.to - b.to);
    if(this.#entries.length>20000){this.#entries=this.#entries.slice(-20000);this.#keys=new Set(this.#entries.map(item=>JSON.stringify([item.from,item.to,item.text,item.source])));}
    return this.#entries.length;
  }

  addSrt(srt, source = "srt") {
    return this.add(parseSrt(srt, source));
  }

  range(start = 0, end = Number.POSITIVE_INFINITY) {
    const from = Math.max(0, Number(start) || 0);
    const to = Math.max(from, Number(end) || 0);
    return this.#entries.filter(item => item.to >= from && item.from <= to).map(item => ({ ...item }));
  }

  at(timestamp) {
    const time = Math.max(0, Number(timestamp) || 0);
    return this.#entries.filter(item => item.from <= time && item.to >= time).map(item => ({ ...item }));
  }

  search(query, { start = 0, end = Number.POSITIVE_INFINITY, limit = 20 } = {}) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return [];
    return this.range(start, end).filter(item => item.text.toLowerCase().includes(needle)).slice(0, Math.max(1, Number(limit) || 20));
  }

  get size() {
    return this.#entries.length;
  }

  all() {
    return this.#entries.map(item => ({ ...item }));
  }

  clear() {
    this.#entries = [];
    this.#keys.clear();
  }
}
