export class RingBuffer {
  #items = [];
  #maxDuration;
  #maxBytes;
  #bytes = 0;

  constructor({ maxDuration = 300, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.#maxDuration = Math.max(1, Number(maxDuration) || 300);
    this.#maxBytes = Math.max(1, Number(maxBytes) || 500 * 1024 * 1024);
  }

  add(item, sizeBytes = estimateSize(item)) {
    const entry = { ...item, timestamp: Math.max(0, Number(item.timestamp) || 0), sizeBytes: Math.max(0, Number(sizeBytes) || 0) };
    this.#items.push(entry);
    this.#bytes += entry.sizeBytes;
    this.#trim(entry.timestamp);
    return entry;
  }

  #trim(latestTimestamp) {
    const oldestAllowed = Math.max(0, latestTimestamp - this.#maxDuration);
    while (this.#items.length && (this.#items[0].timestamp < oldestAllowed || this.#bytes > this.#maxBytes)) {
      const removed = this.#items.shift();
      this.#bytes -= removed.sizeBytes;
    }
  }

  range(start = 0, end = Number.POSITIVE_INFINITY) {
    const from = Number(start) || 0;
    const to = Number.isFinite(Number(end)) ? Number(end) : Number.POSITIVE_INFINITY;
    return this.#items.filter(item => item.timestamp >= from && item.timestamp <= to).map(item => ({ ...item }));
  }

  get start() {
    return this.#items[0]?.timestamp ?? null;
  }

  get end() {
    return this.#items.at(-1)?.timestamp ?? null;
  }

  get size() {
    return this.#items.length;
  }

  get bytes() {
    return this.#bytes;
  }

  clear() {
    this.#items = [];
    this.#bytes = 0;
  }
}

function estimateSize(item) {
  if (!item) return 0;
  if (typeof item.data === "string") return Math.ceil(item.data.length * 0.75);
  return JSON.stringify(item).length;
}
