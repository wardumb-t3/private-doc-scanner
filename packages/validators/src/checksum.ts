/**
 * Deterministic check-digit algorithms. These never guess: a value either
 * passes or it does not, which is what lets on-device extraction be trusted
 * without a human (or an AI) looking at the document.
 */

const MRZ_WEIGHTS = [7, 3, 1] as const;

/** Numeric value of one MRZ character per ICAO 9303 part 3 §4.9. */
function mrzCharValue(ch: string): number {
  if (ch === "<") return 0;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 90) return code - 55; // A=10 … Z=35
  throw new RangeError(`invalid MRZ character: ${JSON.stringify(ch)}`);
}

/** ICAO 9303 check digit (weights 7-3-1, mod 10). */
export function mrzCheckDigit(value: string): number {
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    sum += mrzCharValue(value[i]!) * MRZ_WEIGHTS[i % 3]!;
  }
  return sum % 10;
}

/** Luhn (mod 10) check used by card numbers and many national IDs. */
export function isValidLuhn(digits: string): boolean {
  const clean = digits.replace(/[\s-]/g, "");
  if (!/^\d{2,}$/.test(clean)) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Country code → IBAN length (ISO 13616 registry, common subset). */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21,
  CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
};

/** Normalise an IBAN to its electronic form (upper case, no spaces). */
export function normalizeIban(iban: string): string {
  return iban.replace(/[\s-]/g, "").toUpperCase();
}

/** ISO 13616 IBAN validation: registry length + mod-97 == 1. */
export function isValidIban(iban: string): boolean {
  const clean = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(clean)) return false;
  const expected = IBAN_LENGTHS[clean.slice(0, 2)];
  if (expected !== undefined && clean.length !== expected) return false;
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch;
    for (const digit of chunk) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}
