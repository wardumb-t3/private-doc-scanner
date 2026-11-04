/**
 * Dates are shown and typed as DD-MM-YYYY; everything stored and sent stays
 * ISO YYYY-MM-DD (what the checks and the T3 contract expect).
 */

export const DATE_FORMAT_LABEL = "DD-MM-YYYY";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "2025-03-01" → "01-03-2025" (anything else is returned unchanged). */
export function isoToDisplay(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

/** "01-03-2025", "1/3/2025", "01.03.2025" or ISO → "2025-03-01"; null if not a real date. */
export function displayToIso(text: string): string | null {
  const t = text.trim();
  let m = t.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4})$/);
  if (m) return validIso(+m[3]!, +m[2]!, +m[1]!);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validIso(+m[1]!, +m[2]!, +m[3]!);
  return null;
}

/** Stored ranges are "start/end" in ISO. */
export function isoRangeToDisplay(range: string): string {
  const [a, b] = range.split("/");
  return a && b ? `${isoToDisplay(a)} to ${isoToDisplay(b)}` : range;
}

export function displayToIsoRange(text: string): string | null {
  const parts = text.split(/\s+(?:to|-|–)\s+|\s*\/\s*(?=\d{1,2}[-./]\d{1,2}[-./]\d{4})/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = displayToIso(parts[0]!);
  const b = displayToIso(parts[1]!);
  return a && b && a <= b ? `${a}/${b}` : null;
}
