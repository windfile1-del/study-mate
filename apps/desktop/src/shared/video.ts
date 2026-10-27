export interface VideoRange {
  start: number;
  end: number;
  basis: string;
}
export function locateVideoQuestion(text: string, time: number, duration = 0): VideoRange {
  const hits = [
    ...text.matchAll(
      /(?<!\d)(?:(\d{1,3}):(\d{2})(?::(\d{2}))?|(?:(\d+)\s*(?:分(?:钟)?|min)\s*)?(\d+(?:\.\d+)?)\s*(?:秒|s)(?![a-z])|(\d+)\s*分钟)/gi,
    ),
  ];
  const seconds = hits
    .map((m) =>
      m[1] !== undefined
        ? m[3] !== undefined
          ? +m[1] * 3600 + +m[2] * 60 + +m[3]
          : +m[1] * 60 + +m[2]
        : m[6] !== undefined
          ? +m[6] * 60
          : +(m[4] || 0) * 60 + +m[5],
    )
    .filter(Number.isFinite);
  let start =
    seconds.length > 1
      ? Math.min(seconds[0], seconds[1])
      : Math.max(0, (seconds[0] ?? time) - (seconds.length ? 3 : 30));
  let end =
    seconds.length > 1 ? Math.max(seconds[0], seconds[1]) : (seconds[0] ?? time) + (seconds.length ? 3 : 0);
  if (duration > 0) {
    start = Math.min(start, duration);
    end = Math.min(end, duration);
  }
  return {
    start,
    end: Math.max(start + 0.1, end),
    basis: seconds.length ? '问题中的明确时间（供模型判断）' : '发送时进度附近',
  };
}
