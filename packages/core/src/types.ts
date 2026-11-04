/**
 * Shared, DOM-free types. Everything here must be safe to use in a browser,
 * a Web Worker, React Native or Node (bench + tests).
 */

/** Where a field value came from, in descending order of trust. */
export type FieldSource = "text_layer" | "barcode" | "mrz" | "ocr" | "user";

export const SOURCE_PRIORITY: Record<FieldSource, number> = {
  text_layer: 4,
  barcode: 4,
  mrz: 4,
  ocr: 2,
  user: 5,
};

export type DocType = "passport" | "id_card" | "payslip" | "bank_statement" | "generic";

/** Axis-aligned box in page pixel coordinates (origin top-left). */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A box rotated by `angle` radians around its centre. `x,y,w,h` describe the
 * box before rotation; `w` runs along the text, `h` across it.
 */
export interface RotatedBox extends BBox {
  angle: number;
}

export interface TextLine {
  text: string;
  /** Axis-aligned bounds (layout, evidence). */
  bbox: BBox;
  /** Tight rotated box when the engine knows the text angle (skewed photos). */
  rect?: RotatedBox;
  /** 0..1 — 1 for text-layer text. */
  confidence: number;
  page: number;
  source: "text_layer" | "ocr";
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  source: "text_layer" | "ocr";
  lines: TextLine[];
}

/** RGBA pixels, same layout as `ImageData` but without the DOM dependency. */
export interface PageImage {
  page: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface CheckResult {
  id: string;
  ok: boolean;
  message: string;
  /** Field keys the check vouches for (on success) or implicates (on failure). */
  fields: string[];
}

export interface FieldEvidence {
  page: number;
  bbox: BBox;
  /** Size of the coordinate space `bbox` is expressed in (the page as read). */
  space?: { width: number; height: number };
}

export interface ExtractedField {
  key: string;
  label: string;
  value: string | null;
  source: FieldSource;
  confidence: number;
  /** A deterministic check (check digit, checksum, arithmetic) vouches for the value. */
  validated: boolean;
  /**
   * Ids of the checks vouching for the value. Ids starting with `mrz.` or
   * `iban.` come from reading the document and are dropped if the user edits
   * the field; schema checks (arithmetic) are re-run on the edited values.
   */
  validatedBy: string[];
  /** Shown highlighted in review; the user must look at it before submit. */
  needsReview: boolean;
  /** The user changed the extracted value. */
  userEdited: boolean;
  required: boolean;
  /** Location on the page, used only on-device to crop a preview for review. */
  evidence?: FieldEvidence;
}

export interface QualityReport {
  ok: boolean;
  blurScore: number;
  glareRatio: number;
  width: number;
  height: number;
  issues: ("blurry" | "glare" | "too_small" | "too_dark")[];
}

export interface ExtractionResult {
  docType: DocType;
  fields: ExtractedField[];
  checks: CheckResult[];
  pageCount: number;
  sourcesUsed: FieldSource[];
  warnings: string[];
  quality?: QualityReport;
  timingsMs: Record<string, number>;
  /**
   * Downscaled page images for the on-device review screen only. Never part
   * of a submission; call `releaseResult()` to wipe them when done.
   */
  previews: PageImage[];
}

export interface OcrOptions {
  /** Restrict recognition to these characters (used for MRZ). */
  charWhitelist?: string;
  /** Hint that the image is a single text line or a small band. */
  layout?: "page" | "band";
}

/** Pluggable OCR engine — implement this to add PaddleOCR, Tesseract, Apple Vision, ML Kit… */
export interface OcrEngine {
  readonly id: string;
  recognize(image: PageImage, options?: OcrOptions): Promise<TextLine[]>;
  /**
   * Optional: recognise a single text line inside `bbox` without running
   * detection. Used to complete MRZ lines whose filler runs (<<<<) the
   * detector missed.
   */
  recognizeRegion?(image: PageImage, region: BBox | RotatedBox, options?: OcrOptions): Promise<{ text: string; confidence: number }>;
  dispose?(): Promise<void>;
}

export interface DocumentInput {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

/**
 * Everything the pipeline needs from the platform. `@pde/engines-web`
 * provides a browser implementation; tests and the bench provide Node ones.
 */
export interface PlatformEngines {
  /** Text layer of a PDF, one entry per page; `null` when the input is not a PDF. */
  pdfText(input: DocumentInput): Promise<PageText[] | null>;
  /** Rasterise a PDF page or decode an image. Pages are 1-based. */
  rasterize(input: DocumentInput, page: number): Promise<PageImage>;
  pageCount(input: DocumentInput): Promise<number>;
  ocr: OcrEngine;
  /** Optional MRZ-tuned recogniser; falls back to `ocr` with a whitelist. */
  mrzOcr?: OcrEngine;
  quality?(image: PageImage): QualityReport;
  barcodes?(image: PageImage): Promise<{ format: string; text: string }[]>;
}
