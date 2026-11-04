import type { OcrEngine, OcrOptions, PageImage, TextLine } from "@pde/core";
import type * as TesseractNs from "tesseract.js";

type TesseractModule = Pick<typeof TesseractNs, "createWorker">;

export interface TesseractEngineOptions {
  tesseract: TesseractModule;
  /** Self-hosted paths — tesseract.js otherwise defaults to a public CDN. */
  workerPath: string;
  corePath: string;
  langPath: string;
  lang?: string;
  createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement;
}

/**
 * Tesseract (LSTM) via tesseract.js. Smallest download of the bundled
 * engines (~5 MB with English data vs ~30 MB for PP-OCR + ONNX Runtime), so
 * it is the engine for the low-end tier. Less accurate on photos.
 */
export class TesseractEngine implements OcrEngine {
  readonly id = "tesseract-lstm";
  private readonly opts: TesseractEngineOptions;
  private worker: Promise<TesseractNs.Worker> | null = null;

  constructor(opts: TesseractEngineOptions) {
    this.opts = opts;
  }

  private getWorker(): Promise<TesseractNs.Worker> {
    this.worker ??= this.opts.tesseract.createWorker(this.opts.lang ?? "eng", 1, {
      workerPath: this.opts.workerPath,
      corePath: this.opts.corePath,
      langPath: this.opts.langPath,
      workerBlobURL: false,
      gzip: true,
      cacheMethod: "write",
    });
    return this.worker;
  }

  async recognize(image: PageImage, options: OcrOptions = {}): Promise<TextLine[]> {
    const worker = await this.getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: options.charWhitelist ?? "",
      // 6 = single uniform block (MRZ band), 3 = automatic page segmentation.
      tessedit_pageseg_mode: (options.layout === "band" ? "6" : "3") as TesseractNs.PSM,
      preserve_interword_spaces: "1",
    });
    const canvas = this.opts.createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    const { data } = await worker.recognize(canvas as HTMLCanvasElement, {}, { blocks: true, text: false });
    canvas.width = 1;
    canvas.height = 1;
    const lines: TextLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const text = line.text.replace(/\s+$/, "");
          if (!text.trim()) continue;
          lines.push({
            text,
            bbox: { x: line.bbox.x0, y: line.bbox.y0, w: line.bbox.x1 - line.bbox.x0, h: line.bbox.y1 - line.bbox.y0 },
            confidence: line.confidence / 100,
            page: image.page,
            source: "ocr",
          });
        }
      }
    }
    return lines;
  }

  async dispose(): Promise<void> {
    if (this.worker) await (await this.worker).terminate();
    this.worker = null;
  }
}
