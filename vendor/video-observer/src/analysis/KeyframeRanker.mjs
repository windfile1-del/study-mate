function normalize(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

export class KeyframeRanker {
  rank(frames = [], { query = "", subtitles = [] } = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return frames
      .map(frame => {
        const text = `${frame.ocrText || ""} ${(frame.subtitleText || "")}`.toLowerCase();
        const relevance = terms.length ? terms.filter(term => text.includes(term)).length / terms.length : 0;
        const score =
          normalize(frame.sceneCut ? 0.35 : 0) +
          normalize(frame.qualityScore || 0) * 0.25 +
          normalize(frame.informationScore || 0) * 0.2 +
          relevance * 0.35 +
          (subtitles.some(item => Math.abs(Number(item.from) - Number(frame.timestamp)) < 1.5) ? 0.1 : 0) +
          (frame.hq || frame.qualityLevel === "hq" ? 0.15 : 0);
        return { ...frame, relevance, rankScore: Math.min(1, score) };
      })
      .sort((a, b) => b.rankScore - a.rankScore || a.timestamp - b.timestamp);
  }

  select(frames = [], options = {}) {
    const ranked = this.rank(frames, options);
    const limit = Math.min(96, Math.max(1, Number(options.limit) || 6));
    const selected = [];
    for (const frame of ranked) {
      if (selected.every(existing => Math.abs(existing.timestamp - frame.timestamp) >= 0.8)) selected.push(frame);
      if (selected.length >= limit) break;
    }
    return selected.sort((a, b) => a.timestamp - b.timestamp);
  }
}
