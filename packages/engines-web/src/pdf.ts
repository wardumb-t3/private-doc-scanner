import type { DocumentInput, PageImage, PageText, TextLine } from "@pde/core";
import type * as Pdfjs from "pdfjs-dist";

type PdfjsModule = Pick<typeof Pdfjs, "getDocument" | "Util">;
type PdfDoc = Pdfjs.PDFDocumentProxy;

/** A drawable canvas: browser OffscreenCanvas / <canvas>, or @napi-rs/canvas in Node. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): unknown;
}

export interface PdfReaderOptions {
  pdfjs: PdfjsModule;
  createCanvas(width: number, height: number): CanvasLike;
  /**
   * Base URL of self-hosted pdf.js data (`cmaps/`, `standard_fonts/`,
   * `wasm/`, `iccs/`). Never point this at a third-party CDN.
   */
  assetBase?: string;
  /** Longest side, in pixels, pages are read and rendered at. */
  maxSide?: number;
}

/**
 * pdf.js wrapper: text-layer extraction (no OCR needed for digital PDFs)
 * and page rasterisation for scanned pages. Text coordinates are emitted in
 * the same pixel space as the rendered page so field evidence lines up.
 */
export class PdfReader {
  private readonly opts: Required<Omit<PdfReaderOptions, "assetBase">> & { assetBase?: string };
  private readonly docs = new WeakMap<DocumentInput, Pdfjs.PDFDocumentLoadingTask>();

  constructor(opts: PdfReaderOptions) {
    this.opts = { maxSide: 1600, ...opts };
  }

  static isPdf(input: DocumentInput): boolean {
    if (input.mime === "application/pdf") return true;
    const head = new Uint8Array(input.bytes, 0, Math.min(5, input.bytes.byteLength));
    return String.fromCharCode(...head) === "%PDF-";
  }

  private open(input: DocumentInput): Promise<PdfDoc> {
    let task = this.docs.get(input);
    if (!task) {
      const base = this.opts.assetBase?.replace(/\/?$/, "/");
      task = this.opts.pdfjs.getDocument({
        // pdf.js transfers the buffer to its worker; give it a copy.
        data: new Uint8Array(input.bytes.slice(0)),
        ...(base
          ? {
              cMapUrl: `${base}cmaps/`,
              cMapPacked: true,
              standardFontDataUrl: `${base}standard_fonts/`,
              wasmUrl: `${base}wasm/`,
              iccUrl: `${base}iccs/`,
            }
          : {}),
        enableXfa: false,
        stopAtErrors: false,
        // Fetch fonts/CMaps from the page, not pdf.js's worker, so every
        // request shows up in the page's own network record.
        useWorkerFetch: false,
      });
      this.docs.set(input, task);
    }
    return task.promise;
  }

  async pageCount(input: DocumentInput): Promise<number> {
    return (await this.open(input)).numPages;
  }

  private scaleFor(page: Pdfjs.PDFPageProxy): number {
    const vp = page.getViewport({ scale: 1 });
    return this.opts.maxSide / Math.max(vp.width, vp.height);
  }

  async text(input: DocumentInput): Promise<PageText[]> {
    const doc = await this.open(input);
    const out: PageText[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: this.scaleFor(page) });
      const content = await page.getTextContent();
      const items: { str: string; x: number; y: number; w: number; h: number }[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const tx = this.opts.pdfjs.Util.transform(viewport.transform, item.transform) as number[];
        const h = Math.hypot(tx[2]!, tx[3]!) || item.height * viewport.scale;
        items.push({ str: item.str, x: tx[4]!, y: tx[5]! - h, w: item.width * viewport.scale, h });
      }
      out.push({ page: p, width: viewport.width, height: viewport.height, source: "text_layer", lines: groupCells(items, p) });
      page.cleanup();
    }
    return out;
  }

  async render(input: DocumentInput, pageNo: number): Promise<PageImage> {
    const doc = await this.open(input);
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: this.scaleFor(page) });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    const canvas = this.opts.createCanvas(w, h);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvas: canvas as HTMLCanvasElement, canvasContext: ctx, viewport }).promise;
    const data = ctx.getImageData(0, 0, w, h).data;
    // Shrink the canvas so its backing store is released promptly.
    canvas.width = 1;
    canvas.height = 1;
    page.cleanup();
    return { page: pageNo, width: w, height: h, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }

  async close(input: DocumentInput): Promise<void> {
    const task = this.docs.get(input);
    this.docs.delete(input);
    if (task) await task.destroy();
  }
}

/**
 * Merge text items into cells: items on the same baseline are joined; a gap
 * wider than ~1 em starts a new cell (the next table column), matching how
 * OCR detectors split a printed row into boxes.
 */
export function groupCells(
  items: { str: string; x: number; y: number; w: number; h: number }[],
  page: number,
): TextLine[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: (typeof items)[] = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r[0]!.y + r[0]!.h / 2 - (it.y + it.h / 2)) < Math.min(r[0]!.h, it.h) * 0.5);
    if (row) row.push(it);
    else rows.push([it]);
  }
  const lines: TextLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let cell: typeof items = [];
    const flush = () => {
      if (!cell.length) return;
      let text = "";
      for (let i = 0; i < cell.length; i++) {
        const it = cell[i]!;
        if (i > 0) {
          const prev = cell[i - 1]!;
          const gap = it.x - (prev.x + prev.w);
          if (gap > it.h * 0.15 && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
        }
        text += it.str;
      }
      const x = cell[0]!.x;
      const y = Math.min(...cell.map((c) => c.y));
      const r = Math.max(...cell.map((c) => c.x + c.w));
      const b = Math.max(...cell.map((c) => c.y + c.h));
      lines.push({ text: text.replace(/\s+/g, " ").trim(), bbox: { x, y, w: r - x, h: b - y }, confidence: 1, page, source: "text_layer" });
      cell = [];
    };
    for (const it of row) {
      const prev = cell[cell.length - 1];
      if (prev && it.x - (prev.x + prev.w) > Math.max(prev.h, it.h) * 1.2) flush();
      cell.push(it);
    }
    flush();
  }
  return lines.filter((l) => l.text);
}
