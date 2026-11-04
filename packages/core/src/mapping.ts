import { isValidIban, normalizeIban, parseAmount, parseDate, type DateOrder } from "@pde/validators";
import { lineBelow, rightNeighbours, sortReadingOrder } from "./layout.ts";
import type { FieldEvidence, TextLine } from "./types.ts";

/**
 * Anchor-based key/value mapping: find a printed label ("Net Pay",
 * "Closing balance") and read the value next to it — on the same line,
 * the next cell to the right, or the line below. Deterministic, explainable
 * and cheap enough for low-end phones; no language model involved.
 */

export type ValueKind = "text" | "name" | "amount" | "date" | "date_range" | "iban" | "account_number" | "id";

export interface FoundValue {
  value: string;
  /** 0..1, combines OCR confidence and how the value was located. */
  confidence: number;
  evidence: FieldEvidence;
}

export interface ExtractOptions {
  dateOrder?: DateOrder;
}

const AMOUNT_TOKEN =
  /(?:\(\s*)?[-−]?\s*(?:[A-Z]{3}\s?|[$€£¥₹]\s?)?\d{1,3}(?:[,.\s'’]\d{3})*(?:[.,]\d{1,2})?(?:\s*\))?(?:\s?(?:CR|DR)\b)?-?/g;
const DATE_TOKEN =
  /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\s-]+[A-Za-z]{3,9}\.?[\s,-]+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})\b/g;
const IBAN_TOKEN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const ACCOUNT_TOKEN = /\b\d[\d\s-]{4,22}\d\b/g;

/** Split a line's remainder at the first wide gap (≥ 2 spaces) — i.e. the next table cell. */
function firstCell(text: string): string {
  return text.split(/\s{2,}|\t/)[0]!.trim();
}

/** Pull the first value of `kind` out of free text, normalised. */
export function extractValue(text: string, kind: ValueKind, opts: ExtractOptions = {}): string | null {
  const t = text.trim();
  if (!t) return null;
  switch (kind) {
    case "amount": {
      for (const m of t.matchAll(AMOUNT_TOKEN)) {
        const token = m[0].trim();
        // Skip bare integers that look like years or counts when a decimal amount exists later.
        const parsed = parseAmount(token);
        if (!parsed) continue;
        if (!/[.,]\d{2}\b/.test(token) && /[.,]\d{2}\b/.test(t.slice((m.index ?? 0) + token.length))) continue;
        return parsed.value.toFixed(2);
      }
      return null;
    }
    case "date": {
      for (const m of t.matchAll(DATE_TOKEN)) {
        const iso = parseDate(m[0], opts.dateOrder);
        if (iso) return iso;
      }
      return null;
    }
    case "date_range": {
      const dates = [...t.matchAll(DATE_TOKEN)].map((m) => parseDate(m[0], opts.dateOrder)).filter(Boolean);
      return dates.length >= 2 ? `${dates[0]}/${dates[1]}` : null;
    }
    case "iban": {
      for (const m of t.toUpperCase().matchAll(IBAN_TOKEN)) {
        const iban = normalizeIban(m[0]);
        if (isValidIban(iban)) return iban;
      }
      return null;
    }
    case "account_number": {
      const m = t.match(ACCOUNT_TOKEN);
      return m ? m[0].replace(/[\s-]/g, "") : null;
    }
    case "id": {
      const m = firstCell(t).match(/[A-Z0-9][A-Z0-9-]{3,}/i);
      return m ? m[0].toUpperCase() : null;
    }
    case "name": {
      const cell = firstCell(t).replace(/^[:\-–]\s*/, "");
      // A name has letters, no digits, at least one letter run of 2+.
      if (!cell || /\d/.test(cell) || !/\p{L}{2,}/u.test(cell)) return null;
      return cell.replace(/\s+/g, " ");
    }
    case "text": {
      const cell = firstCell(t).replace(/^[:\-–]\s*/, "");
      return cell || null;
    }
  }
}

/**
 * Find a field by its printed label. Anchors are tried in order; the first
 * anchor that yields a parseable value wins.
 */
export function findByAnchors(
  lines: TextLine[],
  anchors: RegExp[],
  kind: ValueKind,
  opts: ExtractOptions = {},
): FoundValue | null {
  const ordered = sortReadingOrder(lines);
  for (const anchor of anchors) {
    for (const line of ordered) {
      const m = anchor.exec(line.text);
      if (!m) continue;
      const rest = line.text.slice((m.index ?? 0) + m[0].length).replace(/^[\s:.\-–#]+/, "");

      const sameLine = extractValue(rest, kind, opts);
      if (sameLine !== null) {
        return { value: sameLine, confidence: line.confidence, evidence: { page: line.page, bbox: line.bbox } };
      }
      for (const right of rightNeighbours(line, ordered).slice(0, 2)) {
        const v = extractValue(right.text, kind, opts);
        if (v !== null) {
          return {
            value: v,
            confidence: Math.min(line.confidence, right.confidence) * 0.95,
            evidence: { page: right.page, bbox: right.bbox },
          };
        }
      }
      const below = lineBelow(line, ordered);
      if (below) {
        const v = extractValue(below.text, kind, opts);
        if (v !== null) {
          return {
            value: v,
            confidence: Math.min(line.confidence, below.confidence) * 0.85,
            evidence: { page: below.page, bbox: below.bbox },
          };
        }
      }
    }
  }
  return null;
}

/**
 * Infer whether numeric dates on this document are day-first or month-first
 * from any date whose first or second part is > 12. Returns undefined when
 * the document gives no evidence (or contradicting evidence).
 */
export function inferDateOrder(lines: TextLine[]): DateOrder | undefined {
  let dmy = 0;
  let mdy = 0;
  for (const line of lines) {
    for (const m of line.text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g)) {
      const a = +m[1]!;
      const b = +m[2]!;
      if (a > 12 && b <= 12) dmy++;
      else if (b > 12 && a <= 12) mdy++;
    }
  }
  if (dmy && !mdy) return "DMY";
  if (mdy && !dmy) return "MDY";
  return undefined;
}

/**
 * Generic `Label: value` pairs for unknown documents. Only colon-separated
 * pairs are taken, to keep false positives low; everything is flagged for
 * review by the caller.
 */
export function findKeyValuePairs(lines: TextLine[]): { label: string; value: string; line: TextLine }[] {
  const out: { label: string; value: string; line: TextLine }[] = [];
  for (const line of sortReadingOrder(lines)) {
    const m = line.text.match(/^\s*([\p{L}][\p{L}\p{N} ./()&'-]{1,40}?)\s*:\s*(\S.*)$/u);
    if (m) out.push({ label: m[1]!.trim(), value: m[2]!.trim(), line });
  }
  return out;
}
