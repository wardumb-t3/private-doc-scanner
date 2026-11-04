import { rotatedBounds, type BBox, type OcrEngine, type OcrOptions, type PageImage, type RotatedBox, type TextLine } from "@pde/core";
import type * as Ort from "onnxruntime-web";
import { allowedClasses, buildCharset, ctcDecode } from "./ctc.ts";
import { dbBoxes, DEFAULT_DB, type DbParams } from "./db-postprocess.ts";
import { rotatedToNchwBgr, toNchwBgr } from "./tensor.ts";

type OrtModule = Pick<typeof Ort, "InferenceSession" | "Tensor">;

export interface PaddleModels {
  det: Uint8Array;
  rec: Uint8Array;
  /** Recogniser dictionary, one character per line. */
  dict: string;
}

export interface PaddleOcrOptions {
  ort: OrtModule;
  models: PaddleModels;
  executionProviders?: string[];
  /** Longest side fed to the detector (PaddleOCR default 960). */
  detMaxSide?: number;
  db?: Partial<DbParams>;
  /** Lines below this recognition confidence are dropped. */
  minConfidence?: number;
  onStage?: (stage: string) => void;
}

const DET_MEAN = [0.485, 0.456, 0.406] as const;
const DET_STD = [0.229, 0.224, 0.225] as const;
const REC_MEAN = [0.5, 0.5, 0.5] as const;
const REC_STD = [0.5, 0.5, 0.5] as const;
const REC_H = 48;
const REC_MAX_W = 1600;

/**
 * PaddleOCR (PP-OCR det + rec) on ONNX Runtime. Runs anywhere ONNX Runtime
 * runs: onnxruntime-web (WebGPU / WASM) in the browser, or onnxruntime-node
 * / onnxruntime-web in Node for tests and benchmarks.
 */
export class PaddleOcrEngine implements OcrEngine {
  readonly id = "paddleocr-ppocrv4";
  private readonly ort: OrtModule;
  private readonly det: Ort.InferenceSession;
  private readonly rec: Ort.InferenceSession;
  private readonly charset: string[];
  private readonly opts: Required<Pick<PaddleOcrOptions, "detMaxSide" | "minConfidence">> & { db: DbParams };

  private constructor(
    ort: OrtModule,
    det: Ort.InferenceSession,
    rec: Ort.InferenceSession,
    charset: string[],
    opts: Required<Pick<PaddleOcrOptions, "detMaxSide" | "minConfidence">> & { db: DbParams },
  ) {
    this.ort = ort;
    this.det = det;
    this.rec = rec;
    this.charset = charset;
    this.opts = opts;
  }

  static async create(options: PaddleOcrOptions): Promise<PaddleOcrEngine> {
    const sessionOpts = { executionProviders: options.executionProviders ?? ["wasm"] };
    options.onStage?.("preparing text detection");
    const det = await options.ort.InferenceSession.create(options.models.det, sessionOpts);
    options.onStage?.("preparing text recognition");
    const rec = await options.ort.InferenceSession.create(options.models.rec, sessionOpts);
    return new PaddleOcrEngine(options.ort, det, rec, buildCharset(options.models.dict), {
      detMaxSide: options.detMaxSide ?? 960,
      minConfidence: options.minConfidence ?? 0.5,
      db: { ...DEFAULT_DB, ...options.db },
    });
  }

  async recognize(image: PageImage, options: OcrOptions = {}): Promise<TextLine[]> {
    const boxes = await this.detect(image, options.layout === "band");
    const allowed = options.charWhitelist ? allowedClasses(this.charset, options.charWhitelist) : undefined;
    const lines: TextLine[] = [];
    for (const box of boxes) {
      const { text, confidence } = await this.recognizeBox(image, box.rect, allowed);
      const clean = text.trim();
      if (!clean || confidence < this.opts.minConfidence) continue;
      lines.push({
        text: clean,
        bbox: rotatedBounds(box.rect),
        rect: box.rect,
        confidence: Math.min(confidence, box.score + 0.2),
        page: image.page,
        source: "ocr",
      });
    }
    return lines;
  }

  async recognizeRegion(image: PageImage, region: BBox | RotatedBox, options: OcrOptions = {}) {
    const allowed = options.charWhitelist ? allowedClasses(this.charset, options.charWhitelist) : undefined;
    const r = await this.recognizeBox(image, { angle: 0, ...region }, allowed);
    return { text: r.text.trim(), confidence: r.confidence };
  }

  private async detect(image: PageImage, band: boolean) {
    const scale = Math.min(1, this.opts.detMaxSide / Math.max(image.width, image.height));
    const w = Math.max(32, Math.round((image.width * scale) / 32) * 32);
    const h = Math.max(32, Math.round((image.height * scale) / 32) * 32);
    const input = toNchwBgr(image, { x: 0, y: 0, w: image.width, h: image.height }, w, h, DET_MEAN, DET_STD);
    const feeds = { [this.det.inputNames[0]!]: new this.ort.Tensor("float32", input, [1, 3, h, w]) };
    const out = await this.det.run(feeds);
    const prob = out[this.det.outputNames[0]!]!.data as Float32Array;
    // MRZ bands are dense, evenly spaced lines: a slightly lower box threshold
    // keeps the long filler runs (<<<<) attached to their line.
    const params = band ? { ...this.opts.db, boxThresh: Math.min(this.opts.db.boxThresh, 0.5) } : this.opts.db;
    const sx = image.width / w;
    const sy = image.height / h;
    return dbBoxes(prob, w, h, params)
      .map((b) => {
        // Map the rotated box from detector space back to image pixels.
        const cos = Math.cos(b.angle);
        const sin = Math.sin(b.angle);
        const ux = cos * sx, uy = sin * sy; // along-axis unit vector, scaled
        const vx = -sin * sx, vy = cos * sy; // across-axis
        const len = b.len * Math.hypot(ux, uy);
        const thick = b.thick * Math.hypot(vx, vy);
        const angle = Math.atan2(uy, ux);
        const cx = b.cx * sx;
        const cy = b.cy * sy;
        const rect: RotatedBox = { x: cx - len / 2, y: cy - thick / 2, w: len, h: thick, angle };
        return { rect, score: b.score };
      })
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  }

  private async recognizeBox(image: PageImage, rect: RotatedBox, allowed?: Set<number>) {
    if (rect.w < 2 || rect.h < 2) return { text: "", confidence: 0 };
    const dstW = Math.max(8, Math.min(REC_MAX_W, Math.ceil((REC_H * rect.w) / rect.h)));
    const padW = Math.max(320, Math.ceil(dstW / 8) * 8);
    const sample = { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, len: rect.w, thick: rect.h, angle: rect.angle };
    const input =
      rect.angle === 0
        ? toNchwBgr(image, clampBox(image, rect), dstW, REC_H, REC_MEAN, REC_STD, padW)
        : rotatedToNchwBgr(image, sample, dstW, REC_H, REC_MEAN, REC_STD, padW);
    const feeds = { [this.rec.inputNames[0]!]: new this.ort.Tensor("float32", input, [1, 3, REC_H, padW]) };
    const out = await this.rec.run(feeds);
    const t = out[this.rec.outputNames[0]!]!;
    const [, steps, classes] = t.dims as number[];
    return ctcDecode(t.data as Float32Array, steps!, classes!, this.charset, allowed);
  }

  async dispose(): Promise<void> {
    await this.det.release();
    await this.rec.release();
  }
}

function clampBox(image: PageImage, b: BBox): BBox {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.max(1, Math.min(image.width - x, b.w - (x - b.x))), h: Math.max(1, Math.min(image.height - y, b.h - (y - b.y))) };
}
