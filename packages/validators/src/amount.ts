/**
 * Locale-tolerant money parsing for statements and payslips.
 *
 * Handles `1,234.56`, `1.234,56`, `1 234,56`, `(123.45)`, `-123.45`,
 * `123.45-`, `123.45 CR/DR` and leading/trailing currency symbols or codes.
 * Returns `null` rather than guessing when the text is not a single amount.
 */

export interface ParsedAmount {
  /** Signed value rounded to 2 decimals. */
  value: number;
  /** ISO 4217 code or symbol found next to the number, if any. */
  currency: string | null;
}

const CURRENCY_SYMBOLS = /[$€£¥₹₩₱฿₫₪₦₴₺]|\b(?:[A-Z]{3})\b|\bRp\b|\bRM\b|\bS\$|\bHK\$|\bA\$|\bUS\$/u;

export function parseAmount(raw: string): ParsedAmount | null {
  let text = raw.trim();
  if (!text) return null;

  let negative = false;
  let currency: string | null = null;

  const cur = text.match(CURRENCY_SYMBOLS);
  if (cur) {
    currency = cur[0];
    text = text.replace(cur[0], "").trim();
  }
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (/\b(?:DR|Dr|dr)\.?$/.test(text)) {
    negative = true;
    text = text.replace(/\s*\b(?:DR|Dr|dr)\.?$/, "");
  } else if (/\b(?:CR|Cr|cr)\.?$/.test(text)) {
    text = text.replace(/\s*\b(?:CR|Cr|cr)\.?$/, "");
  }
  if (text.startsWith("-") || text.startsWith("−")) {
    negative = true;
    text = text.slice(1).trim();
  } else if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1).trim();
  }
  // The currency may sit between the sign and the digits ("-$12.00").
  if (!currency) {
    const inner = text.match(CURRENCY_SYMBOLS);
    if (inner) {
      currency = inner[0];
      text = text.replace(inner[0], "").trim();
    }
  }

  if (!/^\d[\d\s.,'’]*$/.test(text)) return null;
  const compact = text.replace(/[\s'’]/g, "");

  const normalized = normalizeSeparators(compact);
  if (normalized === null) return null;

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return { value: negative ? -rounded : rounded, currency };
}

/**
 * Decide which of `.` / `,` is the decimal separator.
 * - both present: the last one is decimal, the other groups thousands;
 * - one present several times: it groups thousands;
 * - one present once with 1–2 digits after: decimal;
 * - one present once with exactly 3 digits after: thousands (1,234 / 1.234).
 */
function normalizeSeparators(compact: string): string | null {
  const dots = compact.split(".").length - 1;
  const commas = compact.split(",").length - 1;
  if (dots === 0 && commas === 0) return compact;
  if (dots > 0 && commas > 0) {
    const decimal = compact.lastIndexOf(".") > compact.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    if (compact.split(decimal).length - 1 !== 1) return null;
    return compact.split(group).join("").replace(decimal, ".");
  }
  const sep = dots > 0 ? "." : ",";
  if (dots + commas > 1) return compact.split(sep).join("");
  const decimals = compact.length - compact.indexOf(sep) - 1;
  if (decimals === 3) return compact.replace(sep, "");
  if (decimals === 1 || decimals === 2) return compact.replace(sep, ".");
  return null;
}

/** Round to cents to avoid float drift when summing amounts. */
export function toCents(value: number): number {
  return Math.round(value * 100);
}
