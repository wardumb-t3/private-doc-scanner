/**
 * DBNet post-processing (Liao et al.), following PaddleOCR: threshold the
 * probability map, label connected components, score each by its mean
 * probability, fit an oriented rectangle (principal axis of the component's
 * pixels — handles tilted phone photos) and grow it by the "unclip" offset
 * D = A·r / L (area A, perimeter L, ratio r).
 */

export interface DetBox {
  /** Centre, in map pixels. */
  cx: number;
  cy: number;
  /** Extent along the text direction. */
  len: number;
  /** Extent across the text direction. */
  thick: number;
  /** Text direction, radians. */
  angle: number;
  score: number;
}

export interface DbParams {
  thresh: number;
  boxThresh: number;
  unclipRatio: number;
  minSize: number;
}

export const DEFAULT_DB: DbParams = { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 3 };

export function dbBoxes(prob: Float32Array, width: number, height: number, p: DbParams = DEFAULT_DB): DetBox[] {
  const labels = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const members = new Int32Array(width * height);
  const boxes: DetBox[] = [];

  for (let start = 0; start < prob.length; start++) {
    if (labels[start] !== 0 || prob[start]! <= p.thresh) continue;
    let top = 0;
    let count = 0;
    stack[top++] = start;
    labels[start] = 1;
    let sum = 0, sx = 0, sy = 0;

    while (top > 0) {
      const idx = stack[--top]!;
      members[count++] = idx;
      const x = idx % width;
      const y = (idx - x) / width;
      sum += prob[idx]!;
      sx += x;
      sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (labels[n] === 0 && prob[n]! > p.thresh) {
            labels[n] = 1;
            stack[top++] = n;
          }
        }
      }
    }

    const score = sum / count;
    if (score < p.boxThresh || count < p.minSize * p.minSize) continue;

    // Principal axis of the component.
    const mx = sx / count;
    const my = sy / count;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < count; i++) {
      const idx = members[i]!;
      const x = (idx % width) - mx;
      const y = Math.floor(idx / width) - my;
      cxx += x * x;
      cyy += y * y;
      cxy += x * y;
    }
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let cos = Math.cos(angle);
    let sin = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const project = () => {
      minU = Infinity; maxU = -Infinity; minV = Infinity; maxV = -Infinity;
      for (let i = 0; i < count; i++) {
        const idx = members[i]!;
        const x = (idx % width) - mx;
        const y = Math.floor(idx / width) - my;
        const u = x * cos + y * sin;
        const v = -x * sin + y * cos;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    };
    project();
    // Near-square blobs (single glyphs) have no reliable direction; keep them upright.
    if (maxU - minU < 1.5 * (maxV - minV) || Math.abs(angle) > Math.PI / 4) {
      angle = 0;
      cos = 1;
      sin = 0;
      project();
    }
    const len = maxU - minU + 1;
    const thick = maxV - minV + 1;
    if (Math.min(len, thick) < p.minSize) continue;
    const d = (len * thick * p.unclipRatio) / (2 * (len + thick));
    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    boxes.push({
      cx: mx + cu * cos - cv * sin + 0.5,
      cy: my + cu * sin + cv * cos + 0.5,
      len: len + 2 * d,
      thick: thick + 2 * d,
      angle,
      score,
    });
  }
  return boxes;
}
