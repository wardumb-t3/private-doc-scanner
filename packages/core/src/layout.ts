import type { BBox, RotatedBox, TextLine } from "./types.ts";

/** Reading order: top-to-bottom, then left-to-right for lines on the same row. */
export function sortReadingOrder(lines: TextLine[]): TextLine[] {
  return [...lines].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (sameRow(a.bbox, b.bbox)) return a.bbox.x - b.bbox.x;
    return a.bbox.y - b.bbox.y;
  });
}

/** Vertical overlap ≥ 50% of the smaller box. */
export function sameRow(a: BBox, b: BBox): boolean {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = bottom - top;
  return overlap > 0 && overlap >= 0.5 * Math.min(a.h, b.h);
}

export function horizontalOverlap(a: BBox, b: BBox): number {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}

/** Lines on the same row and to the right of `line`, nearest first. */
export function rightNeighbours(line: TextLine, all: TextLine[]): TextLine[] {
  return all
    .filter((l) => l !== line && l.page === line.page && sameRow(l.bbox, line.bbox) && l.bbox.x >= line.bbox.x + line.bbox.w - 2)
    .sort((a, b) => a.bbox.x - b.bbox.x);
}

/** The nearest line directly below `line` (within ~2 line heights and horizontally overlapping). */
export function lineBelow(line: TextLine, all: TextLine[]): TextLine | null {
  const maxGap = line.bbox.h * 2.2;
  let best: TextLine | null = null;
  for (const l of all) {
    if (l === line || l.page !== line.page) continue;
    const gap = l.bbox.y - (line.bbox.y + line.bbox.h);
    if (gap < -line.bbox.h * 0.3 || gap > maxGap) continue;
    if (horizontalOverlap(l.bbox, line.bbox) <= 0) continue;
    if (!best || l.bbox.y < best.bbox.y) best = l;
  }
  return best;
}

export function unionBox(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
}

export interface RowText {
  text: string;
  /** Row text with pieces joined without spaces — what MRZ detection wants. */
  compact: string;
  bbox: BBox;
  /** Rotated box, when the row is a single engine line that has one. */
  rect?: RotatedBox;
  confidence: number;
  page: number;
}

/**
 * Merge lines that sit on the same row (OCR detectors often split one
 * printed line at wide gaps) into a single row of text.
 */
export function rowTexts(lines: TextLine[]): RowText[] {
  const ordered = sortReadingOrder(lines);
  const rows: TextLine[][] = [];
  for (const line of ordered) {
    const row = rows[rows.length - 1];
    if (row && row[0]!.page === line.page && sameRow(row[0]!.bbox, line.bbox)) row.push(line);
    else rows.push([line]);
  }
  return rows.map((row) => {
    const sorted = [...row].sort((a, b) => a.bbox.x - b.bbox.x);
    return {
      text: sorted.map((l) => l.text).join("  "),
      compact: sorted.map((l) => l.text).join(""),
      bbox: unionBox(sorted.map((l) => l.bbox)),
      confidence: Math.min(...sorted.map((l) => l.confidence)),
      page: sorted[0]!.page,
      ...(sorted.length === 1 && sorted[0]!.rect ? { rect: sorted[0]!.rect } : {}),
    };
  });
}

/** Axis-aligned bounds of a rotated box. */
export function rotatedBounds(r: RotatedBox): BBox {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const c = Math.abs(Math.cos(r.angle));
  const s = Math.abs(Math.sin(r.angle));
  const w = r.w * c + r.h * s;
  const h = r.w * s + r.h * c;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Dominant text angle of a page from the engine's rotated line boxes
 * (median over clearly elongated lines). 0 when unknown.
 */
export function dominantAngle(lines: TextLine[]): number {
  const angles = lines
    .filter((l) => l.rect && l.rect.w > 3 * l.rect.h)
    .map((l) => l.rect!.angle)
    .sort((a, b) => a - b);
  return angles.length >= 3 ? angles[Math.floor(angles.length / 2)]! : 0;
}

/**
 * Rotate lines by −angle around the page centre so rows are horizontal
 * again. Row grouping and "value to the right of the label" lookups assume
 * level text; a 3° tilt across a page moves a row by a full line height.
 * Returns the deskewed lines (their `rect` is left in image space) and a map
 * from each deskewed `bbox` back to the original one.
 */
export function deskewLines(
  lines: TextLine[],
  angle: number,
  page: { width: number; height: number },
): { lines: TextLine[]; original: Map<BBox, BBox> } {
  const original = new Map<BBox, BBox>();
  if (Math.abs(angle) < (0.3 * Math.PI) / 180) {
    for (const l of lines) original.set(l.bbox, l.bbox);
    return { lines, original };
  }
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const pcx = page.width / 2;
  const pcy = page.height / 2;
  const out = lines.map((l) => {
    const w = l.rect ? l.rect.w : l.bbox.w;
    const h = l.rect ? l.rect.h : l.bbox.h;
    const cx = (l.rect ? l.rect.x + l.rect.w / 2 : l.bbox.x + l.bbox.w / 2) - pcx;
    const cy = (l.rect ? l.rect.y + l.rect.h / 2 : l.bbox.y + l.bbox.h / 2) - pcy;
    const nx = cx * cos - cy * sin + pcx;
    const ny = cx * sin + cy * cos + pcy;
    const bbox = { x: nx - w / 2, y: ny - h / 2, w, h };
    original.set(bbox, l.bbox);
    // `rect` stays in image space so regions can still be re-read from the image.
    return { ...l, bbox };
  });
  return { lines: out, original };
}
