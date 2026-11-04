/**
 * Node implementation of the platform engines, for tests, the benchmark and
 * server-side tooling. Not for production document handling — the point of
 * this project is that documents stay on the user's device.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DocumentInput, PageImage, PlatformEngines } from "@pde/core";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PaddleOcrEngine } from "./paddle/engine.ts";
import { PdfReader } from "./pdf.ts";
import { assessQuality } from "@pde/core";

const require = createRequire(import.meta.url);

export function bundledModelPaths() {
  // The package only exports `./node`, which sits next to the assets folder.
  const dir = join(dirname(require.resolve("@gutenye/ocr-models/node")), "assets");
  return {
    det: join(dir, "ch_PP-OCRv4_det_infer.onnx"),
    rec: join(dir, "ch_PP-OCRv4_rec_infer.onnx"),
    dict: join(dir, "ppocr_keys_v1.txt"),
  };
}

export async function createPaddleNode(): Promise<PaddleOcrEngine> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  const paths = bundledModelPaths();
  return PaddleOcrEngine.create({
    ort,
    models: { det: await readFile(paths.det), rec: await readFile(paths.rec), dict: await readFile(paths.dict, "utf8") },
  });
}

export async function decodeImageNode(input: DocumentInput, maxSide = 1600): Promise<PageImage> {
  const img = await loadImage(Buffer.from(input.bytes));
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { page: 1, width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}

export async function createNodeEngines(opts: { maxSide?: number } = {}): Promise<PlatformEngines & { dispose(): Promise<void> }> {
  const maxSide = opts.maxSide ?? 1600;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const pdf = new PdfReader({ pdfjs, createCanvas: (w, h) => createCanvas(w, h), maxSide, assetBase: `${pdfjsRoot}/` });
  const ocr = await createPaddleNode();
  return {
    pdfText: async (input) => (PdfReader.isPdf(input) ? pdf.text(input) : null),
    pageCount: async (input) => (PdfReader.isPdf(input) ? pdf.pageCount(input) : 1),
    rasterize: async (input, page) => (PdfReader.isPdf(input) ? pdf.render(input, page) : decodeImageNode(input, maxSide)),
    ocr,
    quality: (img) => assessQuality(img),
    dispose: () => ocr.dispose(),
  };
}
