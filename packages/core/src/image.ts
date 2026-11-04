import type { BBox, PageImage } from "./types.ts";

/** Copy a rectangle out of an RGBA image (clamped to bounds). */
export function cropImage(img: PageImage, box: BBox): PageImage {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { page: img.page, width: w, height: h, data };
}

/**
 * Box-filter downscale so the longest side is ≤ `maxSide`. Keeps peak memory
 * low on phones: a 12 MP photo becomes ~1.9 MP before OCR.
 */
export function downscaleImage(img: PageImage, maxSide: number): PageImage {
  const scale = maxSide / Math.max(img.width, img.height);
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const data = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const ys = Math.floor(y * sy);
    const ye = Math.max(ys + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const xs = Math.floor(x * sx);
      const xe = Math.max(xs + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = ys; yy < ye; yy++) {
        let i = (yy * img.width + xs) * 4;
        for (let xx = xs; xx < xe; xx++, i += 4) {
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          a += img.data[i + 3]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = a / n;
    }
  }
  return { page: img.page, width: w, height: h, data };
}

/** Overwrite pixel memory so decoded document pixels do not linger. */
export function wipeImage(img: PageImage): void {
  img.data.fill(0);
}

/**
 * Grayscale + percentile contrast stretch (2nd percentile → black, paper
 * level → white). Recovers faint, blurred or noisy print — used on the MRZ
 * band, where it markedly improves recognition of phone photos.
 */
export function enhanceContrast(img: PageImage): PageImage {
  const n = img.width * img.height;
  const gray = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const l = 0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!;
    gray[i] = l;
    hist[Math.round(l)]!++;
  }
  const percentile = (q: number, fromTop: boolean) => {
    let acc = 0;
    for (let k = 0; k < 256; k++) {
      const v = fromTop ? 255 - k : k;
      acc += hist[v]!;
      if (acc >= q * n) return v;
    }
    return fromTop ? 0 : 255;
  };
  const lo = percentile(0.02, false);
  const hi = percentile(0.3, true); // paper: the brightest ~30% of pixels
  const range = Math.max(1, hi - lo);
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = ((gray[i]! - lo) / range) * 255;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { page: img.page, width: img.width, height: img.height, data };
}
