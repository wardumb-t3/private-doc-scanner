import type { PageImage, QualityReport } from "./types.ts";

/**
 * Capture quality gate, run before OCR on photos. Rejecting a bad photo and
 * asking for a retake is the single biggest accuracy lever on-device.
 *
 * - blur: variance of the Laplacian on a ~640px grayscale copy (low = blurry)
 * - glare: share of near-white, low-saturation pixels clearly brighter than
 *   the paper itself (so a white page or a flatbed scan is not "glare")
 * - darkness: mean luminance
 */
export interface QualityThresholds {
  minBlurScore: number;
  maxGlareRatio: number;
  minShortSide: number;
  minMeanLuma: number;
}

export const DEFAULT_QUALITY: QualityThresholds = {
  minBlurScore: 60,
  maxGlareRatio: 0.08,
  minShortSide: 500,
  minMeanLuma: 50,
};

const ANALYSIS_SIDE = 640;

export function assessQuality(img: PageImage, t: QualityThresholds = DEFAULT_QUALITY): QualityReport {
  const step = Math.max(1, Math.floor(Math.max(img.width, img.height) / ANALYSIS_SIDE));
  const w = Math.floor(img.width / step);
  const h = Math.floor(img.height / step);
  const gray = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  const whiteish = new Uint8Array(w * h);
  let lumaSum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y * step) * img.width + x * step) * 4;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[y * w + x] = l;
      lumaSum += l;
      hist[Math.min(255, Math.round(l))]!++;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (min > 245 && max - min < 12) whiteish[y * w + x] = 1;
    }
  }

  // Paper brightness ≈ 75th luminance percentile (documents are mostly paper).
  let acc = 0;
  let paper = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= 0.75 * w * h) {
      paper = v;
      break;
    }
  }
  let glare = 0;
  if (paper < 235) {
    for (let i = 0; i < whiteish.length; i++) glare += whiteish[i]!;
  }

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = y * w + x;
      const lap = gray[c - w]! + gray[c + w]! + gray[c - 1]! + gray[c + 1]! - 4 * gray[c]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const blurScore = n ? sumSq / n - mean * mean : 0;
  const glareRatio = glare / Math.max(1, w * h);
  const meanLuma = lumaSum / Math.max(1, w * h);

  const issues: QualityReport["issues"] = [];
  if (Math.min(img.width, img.height) < t.minShortSide) issues.push("too_small");
  if (blurScore < t.minBlurScore) issues.push("blurry");
  if (glareRatio > t.maxGlareRatio) issues.push("glare");
  if (meanLuma < t.minMeanLuma) issues.push("too_dark");

  return {
    ok: issues.length === 0,
    blurScore: Math.round(blurScore),
    glareRatio: Math.round(glareRatio * 1000) / 1000,
    width: img.width,
    height: img.height,
    issues,
  };
}
