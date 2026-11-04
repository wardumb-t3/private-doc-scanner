/**
 * Date parsing for printed documents. Output is always ISO `YYYY-MM-DD`.
 * Ambiguous numeric dates (`03/04/2025`) are resolved with an explicit
 * order hint; when no hint is given and the date is ambiguous we return
 * `null` so the field is routed to user review instead of guessed.
 */

export type DateOrder = "DMY" | "MDY" | "YMD";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function expandYear(y: number): number {
  if (y >= 100) return y;
  const nowYY = new Date().getUTCFullYear() % 100;
  return y <= nowYY + 10 ? 2000 + y : 1900 + y;
}

function iso(y: number, m: number, d: number): string | null {
  return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export function parseDate(raw: string, order?: DateOrder): string | null {
  const text = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");

  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);

  m = text.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? iso(expandYear(+m[3]!), month, +m[1]!) : null;
  }
  m = text.match(/^([A-Za-z]{3,9})\.?[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? iso(expandYear(+m[3]!), month, +m[2]!) : null;
  }

  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = expandYear(+m[3]!);
    if (order === "DMY") return iso(y, b, a);
    if (order === "MDY") return iso(y, a, b);
    if (a > 12 && b <= 12) return iso(y, b, a);
    if (b > 12 && a <= 12) return iso(y, a, b);
    if (a === b) return iso(y, a, b);
    return null; // ambiguous without a hint
  }
  return null;
}

/**
 * MRZ `YYMMDD` → ISO. Birth dates resolve to the most recent past century;
 * expiry dates resolve forward (passports are valid ≤ ~10–20 years).
 */
export function parseMrzDate(yymmdd: string, kind: "birth" | "expiry"): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = +yymmdd.slice(0, 2);
  const mm = +yymmdd.slice(2, 4);
  const dd = +yymmdd.slice(4, 6);
  const nowYY = new Date().getUTCFullYear() % 100;
  let year: number;
  if (kind === "birth") year = yy > nowYY ? 1900 + yy : 2000 + yy;
  else year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return iso(year, mm, dd);
}
