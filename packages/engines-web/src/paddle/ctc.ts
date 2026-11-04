/**
 * Greedy CTC decoding. Class 0 is the blank, classes 1..N map to the
 * dictionary, and the last class is a space (PaddleOCR `use_space_char`).
 * With `allowed`, recognition is constrained to a character set (e.g. the
 * MRZ alphabet) by taking the arg-max over blank + allowed classes only.
 */
export function ctcDecode(
  probs: Float32Array,
  steps: number,
  classes: number,
  charset: string[],
  allowed?: Set<number>,
): { text: string; confidence: number } {
  let text = "";
  let confSum = 0;
  let kept = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    const row = t * classes;
    let best = 0;
    let bestP = probs[row]!;
    if (allowed) {
      for (const c of allowed) {
        const v = probs[row + c]!;
        if (v > bestP) {
          bestP = v;
          best = c;
        }
      }
    } else {
      for (let c = 1; c < classes; c++) {
        const v = probs[row + c]!;
        if (v > bestP) {
          bestP = v;
          best = c;
        }
      }
    }
    if (best !== 0 && best !== prev) {
      text += charset[best - 1] ?? "";
      confSum += bestP;
      kept++;
    }
    prev = best;
  }
  return { text, confidence: kept ? confSum / kept : 0 };
}

/** Build the class → character table: dictionary lines plus trailing space. */
export function buildCharset(dict: string): string[] {
  const chars = dict.replace(/\r/g, "").split("\n");
  if (chars[chars.length - 1] === "") chars.pop();
  chars.push(" ");
  return chars;
}

/** Class indices (1-based, blank excluded) for the characters in `whitelist`. */
export function allowedClasses(charset: string[], whitelist: string): Set<number> {
  const wanted = new Set(whitelist);
  const out = new Set<number>();
  charset.forEach((ch, i) => {
    if (wanted.has(ch)) out.add(i + 1);
  });
  return out;
}
