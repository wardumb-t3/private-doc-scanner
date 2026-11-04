import type { DocumentInput, OcrEngine, PageImage, PageText, PlatformEngines, TextLine } from "../src/index.ts";

/** Lay text rows out top-to-bottom; `|` splits a row into separate cells. */
export function linesFrom(rows: string[], source: "text_layer" | "ocr" = "text_layer", confidence = 1, page = 1): TextLine[] {
  const out: TextLine[] = [];
  rows.forEach((row, i) => {
    let x = 20;
    for (const cell of row.split("|")) {
      const text = cell.trim();
      const w = Math.max(10, text.length * 8);
      if (text) out.push({ text, bbox: { x, y: 20 + i * 24, w, h: 16 }, confidence, page, source });
      x += w + 40;
    }
  });
  return out;
}

export function blankImage(width = 800, height = 560, page = 1): PageImage {
  return { page, width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

export function fakeOcr(id: string, respond: (img: PageImage, opts?: { charWhitelist?: string }) => TextLine[]): OcrEngine & { calls: number } {
  const engine = {
    id,
    calls: 0,
    async recognize(img: PageImage, opts?: { charWhitelist?: string }) {
      engine.calls++;
      return respond(img, opts);
    },
  };
  return engine;
}

export const PDF: DocumentInput = { name: "doc.pdf", mime: "application/pdf", bytes: new ArrayBuffer(8) };
export const JPG: DocumentInput = { name: "photo.jpg", mime: "image/jpeg", bytes: new ArrayBuffer(8) };

export function engines(opts: {
  text?: PageText[] | null;
  ocr?: OcrEngine;
  mrzOcr?: OcrEngine;
  pages?: number;
}): PlatformEngines {
  return {
    pdfText: async () => opts.text ?? null,
    rasterize: async (_input, page) => blankImage(800, 560, page),
    pageCount: async () => opts.pages ?? 1,
    ocr: opts.ocr ?? fakeOcr("none", () => []),
    ...(opts.mrzOcr ? { mrzOcr: opts.mrzOcr } : {}),
    quality: (img) => ({ ok: true, blurScore: 100, glareRatio: 0, width: img.width, height: img.height, issues: [] }),
  };
}
