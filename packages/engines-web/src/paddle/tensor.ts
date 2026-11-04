import type { PageImage } from "@pde/core";

/**
 * Bilinear resize of an RGBA image straight into a normalised NCHW float
 * tensor in BGR channel order (PaddleOCR models are trained on OpenCV BGR).
 * `outW` may exceed `dstW`; the extra columns are zero padding.
 */
export function toNchwBgr(
  img: PageImage,
  src: { x: number; y: number; w: number; h: number },
  dstW: number,
  dstH: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
  outW = dstW,
): Float32Array {
  const plane = dstH * outW;
  const out = new Float32Array(3 * plane);
  const sx = src.w / dstW;
  const sy = src.h / dstH;
  const bgr = [2, 1, 0]; // output channel c reads RGBA channel bgr[c]
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(src.h - 1, Math.max(0, (y + 0.5) * sy - 0.5)) + src.y;
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(src.w - 1, Math.max(0, (x + 0.5) * sx - 0.5)) + src.x;
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * img.width + x0) * 4;
      const i01 = (y0 * img.width + x1) * 4;
      const i10 = (y1 * img.width + x0) * 4;
      const i11 = (y1 * img.width + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const k = bgr[c]!;
        const top = img.data[i00 + k]! * (1 - wx) + img.data[i01 + k]! * wx;
        const bottom = img.data[i10 + k]! * (1 - wx) + img.data[i11 + k]! * wx;
        const v = (top * (1 - wy) + bottom * wy) / 255;
        out[c * plane + y * outW + x] = (v - mean[c]!) / std[c]!;
      }
    }
  }
  return out;
}

/**
 * Sample a rotated rectangle (centre cx,cy; `len` along `angle`, `thick`
 * across) into a straightened NCHW BGR tensor — PaddleOCR's
 * get_rotate_crop_image, done with bilinear sampling instead of a warp.
 */
export function rotatedToNchwBgr(
  img: PageImage,
  r: { cx: number; cy: number; len: number; thick: number; angle: number },
  dstW: number,
  dstH: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
  outW = dstW,
): Float32Array {
  const plane = dstH * outW;
  const out = new Float32Array(3 * plane);
  const cos = Math.cos(r.angle);
  const sin = Math.sin(r.angle);
  const bgr = [2, 1, 0];
  const maxX = img.width - 1;
  const maxY = img.height - 1;
  for (let j = 0; j < dstH; j++) {
    const v = ((j + 0.5) / dstH - 0.5) * r.thick;
    for (let i = 0; i < dstW; i++) {
      const u = ((i + 0.5) / dstW - 0.5) * r.len;
      const fx = Math.min(maxX, Math.max(0, r.cx + u * cos - v * sin - 0.5));
      const fy = Math.min(maxY, Math.max(0, r.cy + u * sin + v * cos - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const wx = fx - x0;
      const wy = fy - y0;
      const i00 = (y0 * img.width + x0) * 4;
      const i01 = (y0 * img.width + x1) * 4;
      const i10 = (y1 * img.width + x0) * 4;
      const i11 = (y1 * img.width + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const k = bgr[c]!;
        const top = img.data[i00 + k]! * (1 - wx) + img.data[i01 + k]! * wx;
        const bottom = img.data[i10 + k]! * (1 - wx) + img.data[i11 + k]! * wx;
        out[c * plane + j * outW + i] = ((top * (1 - wy) + bottom * wy) / 255 - mean[c]!) / std[c]!;
      }
    }
  }
  return out;
}
