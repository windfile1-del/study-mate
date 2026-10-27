function asArray(value) {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function averageHash(pixels) {
  const values = asArray(pixels);
  if (!values.length) return null;
  const average = mean(values);
  return values.map(value => (value >= average ? "1" : "0")).join("");
}

export function hammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) return 1;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) distance += 1;
  return distance / left.length;
}

export function histogramDifference(left, right) {
  const a = asArray(left);
  const b = asArray(right);
  const length = Math.max(a.length, b.length);
  if (!length) return 0;
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs((a[i] || 0) - (b[i] || 0));
  return total / length;
}

export function ssimApprox(left, right) {
  const a = asArray(left);
  const b = asArray(right);
  if (!a.length || a.length !== b.length) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    varianceA += da * da;
    varianceB += db * db;
    covariance += da * db;
  }
  const n = a.length || 1;
  const c1 = 6.5025;
  const c2 = 58.5225;
  return ((2 * ma * mb + c1) * (2 * covariance / n + c2)) / ((ma * ma + mb * mb + c1) * (varianceA / n + varianceB / n + c2));
}

export function compareFrames(previous = {}, current = {}) {
  const hashA = previous.hash || averageHash(previous.pixels);
  const hashB = current.hash || averageHash(current.pixels);
  const known = Boolean(hashA && hashB) || Boolean(previous.histogram?.length && current.histogram?.length) || Boolean(previous.pixels?.length && current.pixels?.length);
  const phash = hashA && hashB ? hammingDistance(hashA, hashB) : 0;
  const histogram = histogramDifference(previous.histogram, current.histogram);
  const ssim = ssimApprox(previous.pixels, current.pixels);
  const edge = histogramDifference(previous.edges, current.edges);
  const changed = phash > 0.18 || histogram > 0.18 || (ssim > 0 && ssim < 0.82) || edge > 0.2;
  return { phash, histogram, ssim, edge, changed: known && changed, known };
}

export function isDuplicate(comparison, threshold = 0.12) {
  return !comparison?.changed || (comparison.phash <= threshold && comparison.histogram <= threshold && (!comparison.ssim || comparison.ssim >= 0.9));
}
