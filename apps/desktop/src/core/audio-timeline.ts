export interface AudioClock {
  wall: number;
  time: number;
  rate: number;
  paused: boolean;
  sourceId: string;
  visitId: string;
  seeking?: boolean;
  preservesPitch?: boolean;
}
export interface AudioSpan {
  from: number;
  to: number;
  mediaStart: number;
  rate: number;
  epoch: number;
  sourceId: string;
  visitId: string;
  preservesPitch: boolean;
}
// Discontinuous intervals are discarded, never stretched across a seek or source change.
export class AudioTimeline {
  private previous: AudioClock | null = null;
  private epoch = 0;
  readonly spans: AudioSpan[] = [];
  gaps = 0;
  push(clock: AudioClock) {
    const p = this.previous;
    this.previous = clock;
    if (!p) return;
    const elapsed = (clock.wall - p.wall) / 1000,
      predicted = p.time + elapsed * p.rate;
    if (
      elapsed <= 0 ||
      elapsed > 1 ||
      p.sourceId !== clock.sourceId ||
      p.visitId !== clock.visitId ||
      p.rate !== clock.rate ||
      p.preservesPitch !== clock.preservesPitch ||
      p.paused ||
      clock.paused ||
      p.seeking ||
      clock.seeking ||
      Math.abs(predicted - clock.time) > 0.35
    ) {
      this.epoch++;
      if (!p.paused && !clock.paused) this.gaps++;
      return;
    }
    this.spans.push({
      from: p.wall,
      to: clock.wall,
      mediaStart: p.time,
      rate: p.rate,
      epoch: this.epoch,
      sourceId: p.sourceId,
      visitId: p.visitId,
      preservesPitch: p.preservesPitch !== false,
    });
    if (this.spans.length > 1000) this.spans.splice(0, this.spans.length - 1000);
  }
  slice(samples: Float32Array, wallStart: number, sampleRate = 16000) {
    const end = wallStart + (samples.length / sampleRate) * 1000;
    return this.spans
      .filter((s) => s.to > wallStart && s.from < end)
      .map((s) => {
        const from = Math.max(s.from, wallStart),
          to = Math.min(s.to, end),
          a = Math.max(0, Math.ceil(((from - wallStart) * sampleRate) / 1000)),
          b = Math.min(samples.length, Math.floor(((to - wallStart) * sampleRate) / 1000));
        return {
          ...s,
          from,
          to,
          mediaStart: s.mediaStart + ((from - s.from) / 1000) * s.rate,
          samples: samples.slice(a, b),
        };
      })
      .filter((s) => s.samples.length > 0);
  }
}
