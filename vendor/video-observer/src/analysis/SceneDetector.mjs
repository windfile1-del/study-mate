import { compareFrames } from "./FrameDedup.mjs";

export class SceneDetector {
  #previous = null;
  #scene = 0;

  observe(frame = {}) {
    const comparison = this.#previous ? compareFrames(this.#previous, frame) : { changed: true, phash: 1, histogram: 1, ssim: 0, edge: 1, known: false };
    const sceneCut = Boolean(comparison.changed && (comparison.phash > 0.3 || comparison.histogram > 0.35 || comparison.edge > 0.35));
    if (sceneCut || this.#previous == null) this.#scene += 1;
    this.#previous = frame;
    return { scene: this.#scene, sceneCut, comparison };
  }

  reset() {
    this.#previous = null;
    this.#scene = 0;
  }
}

export function detectSceneCuts(frames = []) {
  const detector = new SceneDetector();
  return frames.map(frame => ({ ...frame, ...detector.observe(frame) }));
}
