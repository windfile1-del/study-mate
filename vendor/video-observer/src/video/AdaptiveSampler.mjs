export const SAMPLING_RATES = Object.freeze({
  stable: 0.5,
  normal: 1,
  fast: 2,
  scene: 6
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class InformationPreservationDetector {
  assess(metrics = {}) {
    const score = clamp(
      Number(metrics.ocrTextDensity || 0) * 0.22 +
        Number(metrics.edgeDensity || 0) * 0.12 +
        Number(metrics.highFrequency || 0) * 0.1 +
        Number(metrics.codeRegion || 0) * 0.2 +
        Number(metrics.formulaRegion || 0) * 0.2 +
        Number(metrics.chartRegion || 0) * 0.08 +
        Number(metrics.uiElements || 0) * 0.04 +
        Number(metrics.smallFontRatio || 0) * 0.18,
      0,
      1
    );
    const hardDetail = Boolean(metrics.codeRegion || metrics.formulaRegion || metrics.smallFontRatio > 0.35);
    const category = hardDetail ? "detail" : score >= 0.55 ? "dense" : score >= 0.28 ? "presentation" : "natural";
    return { score, category, preserveSource: hardDetail || score >= 0.82 };
  }

  choosePreview(width, height, metrics = {}) {
    const sourceWidth = Math.max(1, Math.floor(Number(width) || 1));
    const sourceHeight = Math.max(1, Math.floor(Number(height) || 1));
    const quality = this.assess(metrics);
    if (sourceHeight <= 480 || sourceWidth <= 640 || quality.preserveSource) {
      return { width: sourceWidth, height: sourceHeight, scale: 1, quality };
    }
    const targetHeight = quality.category === "presentation" ? 720 : 540;
    const scale = Math.min(1, targetHeight / sourceHeight);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
      scale,
      quality
    };
  }
}

export class AdaptiveSampler {
  #lastTimestamp = null;

  nextPlan({ timestamp = 0, motionScore = 0, sceneCut = false, sourceWidth = 1920, sourceHeight = 1080, metrics = {} } = {}) {
    const quality = new InformationPreservationDetector().choosePreview(sourceWidth, sourceHeight, metrics);
    const rate = sceneCut ? SAMPLING_RATES.scene : motionScore >= 0.7 ? SAMPLING_RATES.fast : motionScore >= 0.25 ? SAMPLING_RATES.normal : SAMPLING_RATES.stable;
    const interval = 1 / rate;
    const elapsed = this.#lastTimestamp == null ? Infinity : Math.max(0, timestamp - this.#lastTimestamp);
    const capture = elapsed >= interval;
    if (capture) this.#lastTimestamp = timestamp;
    return { capture, rate, interval, elapsed, preview: quality, sceneBurst: sceneCut };
  }

  reset() {
    this.#lastTimestamp = null;
  }
}
