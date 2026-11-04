import { parse } from "mrz";
import { mrzCheckDigit } from "./checksum.ts";
import { parseMrzDate } from "./dates.ts";

/**
 * MRZ (ICAO 9303) handling: pick MRZ lines out of noisy OCR output, then
 * parse with check-digit validation. Every MRZ field carries a check digit,
 * so a passing result is self-proving and needs no human double-check.
 */

export type MrzFormat = "TD1" | "TD2" | "TD3";

const LINE_SHAPES: Record<MrzFormat, { lines: number; length: number }> = {
  TD1: { lines: 3, length: 30 },
  TD2: { lines: 2, length: 36 },
  TD3: { lines: 2, length: 44 },
};

export interface MrzFields {
  documentCode: string | null;
  issuingState: string | null;
  documentNumber: string | null;
  lastName: string | null;
  firstName: string | null;
  nationality: string | null;
  /** ISO date */
  birthDate: string | null;
  sex: string | null;
  /** ISO date */
  expirationDate: string | null;
  personalNumber: string | null;
}

export interface MrzResult {
  format: MrzFormat;
  lines: string[];
  /** All check digits (incl. composite) pass. */
  valid: boolean;
  fields: MrzFields;
  /** Field names whose own check digit or syntax failed. */
  invalidFields: string[];
  /** Characters the parser changed (e.g. O→0 in numeric fields). */
  autocorrected: number;
}

/**
 * Normalise one OCR'd line towards MRZ alphabet [A-Z0-9<].
 * OCR engines commonly read the filler `<` as `«`, `‹`, `(`, `{`, `K` runs
 * or spaces; we only fix the unambiguous ones here and leave letter/digit
 * confusions to the field-aware autocorrect of the parser.
 */
export function normalizeMrzLine(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[«»]/g, "<<")
    .replace(/[‹›(){}[\]]/g, "<")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9<]/g, "");
}

/** Index of the names line, whose trailing fillers carry no information. */
const NAME_LINE: Record<MrzFormat, number> = { TD1: 2, TD2: 0, TD3: 0 };

function fitLength(raw: string, length: number, isNameLine: boolean): string | null {
  // On the names line a run of 3+ fillers ends the names; anything after it
  // is OCR noise from the filler area.
  const line = isNameLine ? raw.replace(/(<{3,})[A-Z0-9<]*$/, (m) => "<".repeat(m.length)) : raw;
  if (line.length === length) return line;
  // OCR detectors often drop long runs of trailing fillers. On the names line
  // that is harmless (no check digit covers it), so pad it back.
  if (isNameLine && line.length < length && line.length >= 10 && line.includes("<<")) {
    return line.padEnd(length, "<");
  }
  // Elsewhere: CTC decoding collapses repeated characters, so long filler
  // runs come out short. Widen the last filler run to the expected length;
  // check digits then confirm (or reject) the alignment.
  if (line.length < length && length - line.length <= 20) {
    const runs = [...line.matchAll(/<{2,}/g)];
    const last = runs[runs.length - 1];
    if (last && last.index !== undefined) {
      const at = last.index + last[0].length;
      return line.slice(0, at) + "<".repeat(length - line.length) + line.slice(at);
    }
    if (length - line.length <= 3) return line.padEnd(length, "<");
  }
  if (line.length > length && line.length - length <= 3 && /<+$/.test(line.slice(length))) {
    return line.slice(0, length);
  }
  return null;
}

/**
 * Find the most plausible MRZ block in OCR text lines (top-to-bottom order).
 * Returns the candidate lines already normalised and length-fitted, or null.
 */
export function findMrzLines(textLines: string[]): { format: MrzFormat; lines: string[] } | null {
  const norm = textLines.map(normalizeMrzLine);
  const candidates: { format: MrzFormat; lines: string[]; score: number }[] = [];

  for (const format of ["TD3", "TD2", "TD1"] as MrzFormat[]) {
    const { lines: n, length } = LINE_SHAPES[format];
    for (let i = 0; i + n <= norm.length; i++) {
      const block: string[] = [];
      for (let k = 0; k < n; k++) {
        const fitted = fitLength(norm[i + k]!, length, k === NAME_LINE[format]);
        if (!fitted) break;
        block.push(fitted);
      }
      if (block.length !== n) continue;
      if (!block.some((l) => l.includes("<"))) continue;
      const score = block.join("").split("<").length; // more fillers ⇒ more MRZ-like
      candidates.push({ format, lines: block, score });
    }
  }
  candidates.sort((a, b) => {
    const va = tryParse(a.lines)?.valid ? 1 : 0;
    const vb = tryParse(b.lines)?.valid ? 1 : 0;
    return vb - va || b.score - a.score;
  });
  const best = candidates[0];
  return best ? { format: best.format, lines: best.lines } : null;
}

function tryParse(lines: string[]) {
  try {
    return parse(lines, { autocorrect: true });
  } catch {
    return null;
  }
}

/** Characters OCR commonly swaps in alphanumeric MRZ fields. */
const CONFUSABLE: Record<string, string[]> = {
  O: ["0"], "0": ["O"], Q: ["0"], D: ["0"],
  I: ["1"], "1": ["I"], L: ["1"],
  S: ["5"], "5": ["S"],
  B: ["8"], "8": ["B"],
  Z: ["2"], "2": ["Z"],
  G: ["6"], "6": ["G"],
};

/** Where the (alphanumeric) document number sits: [line, start]; 9 chars + check digit. */
const DOC_NUMBER_AT: Record<string, [number, number]> = { TD1: [0, 5], TD2: [1, 0], TD3: [1, 0] };

/**
 * The document number mixes letters and digits, so the parser's autocorrect
 * cannot fix O↔0-style misreads there. Try the confusable substitutions and
 * accept one only if it makes the document-number check digit AND the
 * composite check digit pass — two independent checks, so a wrong repair
 * would have to beat ~1-in-100 odds, and we prefer the fewest changes.
 */
function repairDocumentNumber(lines: string[], format: string): { lines: string[]; changes: number } | null {
  const at = DOC_NUMBER_AT[format];
  if (!at) return null;
  const [li, start] = at;
  const line = lines[li]!;
  const field = line.slice(start, start + 9);
  const positions = [...field].map((ch, i) => (CONFUSABLE[ch] ? i : -1)).filter((i) => i >= 0).slice(0, 8);
  const combos: { chars: string[]; changes: number }[] = [];
  for (let mask = 1; mask < 1 << positions.length; mask++) {
    const chars = [...field];
    let changes = 0;
    positions.forEach((pos, bit) => {
      if (mask & (1 << bit)) {
        chars[pos] = CONFUSABLE[chars[pos]!]![0]!;
        changes++;
      }
    });
    combos.push({ chars, changes });
  }
  combos.sort((a, b) => a.changes - b.changes);
  for (const c of combos) {
    const fixed = [...lines];
    fixed[li] = line.slice(0, start) + c.chars.join("") + line.slice(start + 9);
    if (tryParse(fixed)?.valid) return { lines: fixed, changes: c.changes };
  }
  return null;
}

export function parseMrz(lines: string[]): MrzResult | null {
  let result = tryParse(lines);
  if (!result) return null;
  let repaired = 0;
  if (!result.valid && result.details.some((d) => !d.valid && d.field?.startsWith("documentNumber"))) {
    const fix = repairDocumentNumber(lines, result.format);
    if (fix) {
      lines = fix.lines;
      result = tryParse(lines)!;
      repaired = fix.changes;
    }
  }
  if (result.format !== "TD1" && result.format !== "TD2" && result.format !== "TD3") return null;

  const f = result.fields;
  const invalidFields = result.details
    .filter((d) => !d.valid && d.field)
    .map((d) => d.field as string);
  const autocorrected = repaired + result.details.reduce((n, d) => n + (d.autocorrect?.length ?? 0), 0);

  return {
    format: result.format,
    lines,
    valid: result.valid,
    invalidFields: [...new Set(invalidFields)],
    autocorrected,
    fields: {
      documentCode: f.documentCode ?? null,
      issuingState: f.issuingState ?? null,
      documentNumber: result.documentNumber ?? f.documentNumber ?? null,
      lastName: f.lastName ?? null,
      firstName: f.firstName ?? null,
      nationality: f.nationality ?? null,
      birthDate: f.birthDate ? parseMrzDate(f.birthDate, "birth") : null,
      sex: f.sex ?? null,
      expirationDate: f.expirationDate ? parseMrzDate(f.expirationDate, "expiry") : null,
      personalNumber: f.personalNumber ?? null,
    },
  };
}

/** Convenience: locate + parse in one call. */
export function extractMrz(textLines: string[]): MrzResult | null {
  const found = findMrzLines(textLines);
  return found ? parseMrz(found.lines) : null;
}

export interface Td3Input {
  documentCode?: string;
  issuingState: string;
  lastName: string;
  firstName: string;
  documentNumber: string;
  nationality: string;
  /** YYMMDD */
  birthDate: string;
  sex: "M" | "F" | "<";
  /** YYMMDD */
  expirationDate: string;
  personalNumber?: string;
}

function mrzName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z]+/g, "<");
}

/**
 * Build a TD3 (passport) MRZ with correct check digits. Used to generate
 * synthetic test and benchmark documents; never needed at runtime.
 */
export function composeTd3(input: Td3Input): [string, string] {
  const code = (input.documentCode ?? "P").padEnd(2, "<").slice(0, 2);
  const line1 = `${code}${input.issuingState.padEnd(3, "<")}${mrzName(input.lastName)}<<${mrzName(input.firstName)}`
    .padEnd(44, "<")
    .slice(0, 44);
  const doc = input.documentNumber.toUpperCase().padEnd(9, "<").slice(0, 9);
  const personal = (input.personalNumber ?? "").toUpperCase().padEnd(14, "<").slice(0, 14);
  const personalCd = personal === "<".repeat(14) ? "<" : String(mrzCheckDigit(personal));
  const docPart = `${doc}${mrzCheckDigit(doc)}`;
  const birthPart = `${input.birthDate}${mrzCheckDigit(input.birthDate)}`;
  const expPart = `${input.expirationDate}${mrzCheckDigit(input.expirationDate)}`;
  const personalPart = `${personal}${personalCd}`;
  const composite = mrzCheckDigit(`${docPart}${birthPart}${expPart}${personalPart}`);
  const line2 = `${docPart}${input.nationality.padEnd(3, "<")}${birthPart}${input.sex}${expPart}${personalPart}${composite}`;
  return [line1, line2];
}
