import type { DocumentInput, PageImage } from "@pde/core";

/**
 * Decode a photo/scan in the browser, honouring EXIF orientation and
 * downscaling during decode so a 12 MP phone photo never sits in memory at
 * full resolution (iOS Safari kills tabs that grow past its WASM budget).
 */
export async function decodeImageBrowser(input: DocumentInput, maxSide = 1600): Promise<PageImage> {
  const blob = new Blob([input.bytes], { type: input.mime || "image/jpeg" });
  const probe = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(probe.width, probe.height));
  const width = Math.max(1, Math.round(probe.width * scale));
  const height = Math.max(1, Math.round(probe.height * scale));
  let bitmap = probe;
  if (scale < 1) {
    bitmap = await createImageBitmap(blob, {
      imageOrientation: "from-image",
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    });
    probe.close();
  }
  // Safari ignores `resizeWidth` / `resizeQuality`, so the bitmap may still
  // be full size. One big drawImage step then aliases small print (the MRZ
  // goes unreadable), so shrink by halves first, then to the exact size.
  let source: CanvasImageSource = bitmap;
  let sw = bitmap.width;
  let sh = bitmap.height;
  while (sw / 2 >= width * 1.25) {
    const half = createBrowserCanvas(Math.round(sw / 2), Math.round(sh / 2));
    const hctx = half.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(source, 0, 0, sw, sh, 0, 0, half.width, half.height);
    if (source !== bitmap) release(source);
    source = half;
    sw = half.width;
    sh = half.height;
  }
  const canvas = createBrowserCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, width, height);
  if (source !== bitmap) release(source);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  canvas.width = 1;
  canvas.height = 1;
  return { page: 1, width, height, data };
}

export function createBrowserCanvas(width: number, height: number) {
  return typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
}

/** Free a scratch canvas's pixels now rather than at garbage collection. */
function release(c: CanvasImageSource) {
  const canvas = c as { width: number; height: number };
  canvas.width = 1;
  canvas.height = 1;
}
