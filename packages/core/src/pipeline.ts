import { extractMrz, type DateOrder, type MrzResult } from "@pde/validators";
import { findByAnchors, findKeyValuePairs, inferDateOrder } from "./mapping.ts";
import { cropImage, downscaleImage, enhanceContrast, wipeImage } from "./image.ts";
import { deskewLines, dominantAngle, rotatedBounds, rowTexts, unionBox, type RowText } from "./layout.ts";
import { getSchema, type DocumentSchema } from "./schemas/index.ts";
import type {
  BBox,
  CheckResult,
  DocType,
  DocumentInput,
  ExtractedField,
  ExtractionResult,
  FieldEvidence,
  FieldSource,
  OcrEngine,
  PageImage,
  PageText,
  PlatformEngines,
  QualityReport,
  TextLine,
} from "./types.ts";

export interface PipelineOptions {
  docType: DocType;
  /** Fields below this confidence (and not validated) are flagged for review. */
  reviewThreshold?: number;
  /** Hard cap on pages processed — bounds time and memory on low-end devices. */
  maxPages?: number;
  /** Longest side of images handed to OCR. */
  maxImageSide?: number;
  /** Longest side of preview images kept for the review screen (0 = none). */
  previewSide?: number;
  dateOrder?: "DMY" | "MDY" | "YMD";
  signal?: AbortSignal;
  onProgress?: (stage: ProgressStage, page?: number) => void;
}

export type ProgressStage = "text_layer" | "rasterize" | "quality" | "ocr" | "mrz" | "mapping" | "done";

const MIN_TEXT_LAYER_CHARS = 30;
const MRZ_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
/** The MRZ sits in the bottom ~third of passports and ID backs. */
const MRZ_BAND = { top: 0.6, height: 0.4 };

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Extract structured fields from one document, entirely on the device.
 *
 * Source order per page: PDF text layer → OCR. For identity documents the
 * MRZ is read first (from page text, then from a cropped band with a
 * restricted charset). Anchored fields are then mapped and every value is
 * run through deterministic checks.
 */
export async function extractDocument(
  input: DocumentInput,
  engines: PlatformEngines,
  options: PipelineOptions,
): Promise<ExtractionResult> {
  const schema = getSchema(options.docType);
  const threshold = options.reviewThreshold ?? 0.9;
  const maxPages = options.maxPages ?? 10;
  const maxSide = options.maxImageSide ?? 1600;
  const previewSide = options.previewSide ?? 1200;
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const previews: PageImage[] = [];
  const progress = options.onProgress ?? (() => {});

  const time = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      timings[key] = (timings[key] ?? 0) + Math.round(now() - t0);
    }
  };

  const totalPages = await engines.pageCount(input);
  const pages = Math.min(totalPages, maxPages);
  if (totalPages > maxPages) warnings.push(`Only the first ${maxPages} of ${totalPages} pages were read.`);

  progress("text_layer");
  const textPages = await time("text_layer", () => engines.pdfText(input));
  const lines: TextLine[] = [];
  const pageSizes = new Map<number, { width: number; height: number }>();
  const originalBox = new Map<BBox, BBox>();
  let quality: QualityReport | undefined;
  let mrzSource: PageImage | null = null;
  const sources = new Set<FieldSource>();

  for (let p = 1; p <= pages; p++) {
    checkAbort(options.signal);
    const tp: PageText | undefined = textPages?.[p - 1];
    const textChars = tp ? tp.lines.reduce((n, l) => n + l.text.trim().length, 0) : 0;
    const needImage = !tp || textChars < MIN_TEXT_LAYER_CHARS || schema.usesMrz || previewSide > 0;

    let img: PageImage | null = null;
    if (needImage) {
      progress("rasterize", p);
      const raw = await time("rasterize", () => engines.rasterize(input, p));
      img = downscaleImage(raw, maxSide);
      if (img !== raw) wipeImage(raw);
      if (previewSide > 0) {
        const preview = downscaleImage(img, previewSide);
        previews.push(preview === img ? { ...img, data: img.data.slice() } : preview);
      }
    }

    if (tp && textChars >= MIN_TEXT_LAYER_CHARS) {
      lines.push(...tp.lines);
      pageSizes.set(p, { width: tp.width, height: tp.height });
    } else if (img) {
      if (p === 1 && !textPages && engines.quality) {
        progress("quality", p);
        quality = engines.quality(img);
        if (!quality.ok) warnings.push(`Image quality: ${quality.issues.join(", ")}. Consider retaking the photo.`);
      }
      progress("ocr", p);
      const ocrLines = (await time("ocr", () => engines.ocr.recognize(img!, { layout: "page" }))).map((l) => ({ ...l, page: p }));
      // Lay out tilted photos as if they were level; remember the real boxes for evidence.
      const deskewed = deskewLines(ocrLines, dominantAngle(ocrLines), img);
      for (const [d, o] of deskewed.original) originalBox.set(d, o);
      lines.push(...deskewed.lines);
      pageSizes.set(p, { width: img.width, height: img.height });
    }

    if (img) {
      if (schema.usesMrz && p === 1) mrzSource = img;
      else wipeImage(img);
    }
  }
  for (const l of lines) sources.add(l.source);

  const fields = new Map<string, ExtractedField>();
  const checks: CheckResult[] = [];
  const rows = rowTexts(lines);

  const dateOrder = options.dateOrder ?? inferDateOrder(lines);
  if (schema.usesMrz) {
    progress("mrz");
    const mrz = await time("mrz", () => readMrz(rows, mrzSource, engines));
    if (mrzSource) wipeImage(mrzSource);
    if (mrz) {
      sources.add("mrz");
      applyMrz(schema, mrz.result, mrz.evidence, fields, checks);
      checks.push(...vizCrossCheck(mrz.result, rows, lines, fields));
      preferPrintedNames(lines, fields, dateOrder);
    } else {
      warnings.push("No machine-readable zone (the <<< lines) was found. Make sure the whole document is in the photo.");
    }
  }

  progress("mapping");
  for (const spec of schema.fields) {
    if (fields.has(spec.key) || spec.anchors.length === 0) continue;
    const found = findByAnchors(lines, spec.anchors, spec.kind, dateOrder ? { dateOrder } : {});
    const source: FieldSource = found && lineSourceAt(lines, found.evidence) === "text_layer" ? "text_layer" : "ocr";
    fields.set(spec.key, {
      key: spec.key,
      label: spec.label,
      value: found?.value ?? null,
      source,
      confidence: found?.confidence ?? 0,
      // IBANs are only accepted by the extractor when mod-97 passes.
      validated: false,
      validatedBy: spec.kind === "iban" && found !== null ? ["iban.mod97"] : [],
      needsReview: false,
      userEdited: false,
      required: spec.required ?? false,
      ...(found ? { evidence: found.evidence } : {}),
    });
  }
  // Keep every schema field (in schema order), even when not found, so review can ask for it.
  for (const spec of schema.fields) {
    if (!fields.has(spec.key)) {
      fields.set(spec.key, {
        key: spec.key, label: spec.label, value: null, source: "ocr", confidence: 0,
        validated: false, validatedBy: [], needsReview: false, userEdited: false, required: spec.required ?? false,
      });
    }
  }

  if (schema.type === "generic") {
    for (const kv of findKeyValuePairs(lines)) {
      const key = slug(kv.label);
      if (!key || fields.has(key)) continue;
      fields.set(key, {
        key, label: kv.label, value: kv.value, source: kv.line.source, confidence: kv.line.confidence,
        validated: false, validatedBy: [], needsReview: true, userEdited: false, required: false,
        evidence: { page: kv.line.page, bbox: kv.line.bbox },
      });
    }
  }

  const ordered = orderFields(schema, fields);
  for (const f of ordered) {
    if (!f.evidence) continue;
    const bbox = originalBox.get(f.evidence.bbox) ?? f.evidence.bbox;
    const space = pageSizes.get(f.evidence.page);
    f.evidence = { ...f.evidence, bbox, ...(space ? { space } : {}) };
  }
  const result: ExtractionResult = {
    docType: schema.type,
    fields: ordered,
    checks,
    pageCount: totalPages,
    sourcesUsed: [...sources],
    warnings,
    timingsMs: timings,
    previews,
    ...(quality ? { quality } : {}),
  };
  finalizeReview(result, lines, threshold);
  progress("done");
  return result;
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function lineSourceAt(lines: TextLine[], ev: FieldEvidence): "text_layer" | "ocr" {
  const hit = lines.find((l) => l.page === ev.page && l.bbox.x === ev.bbox.x && l.bbox.y === ev.bbox.y);
  return hit?.source ?? "ocr";
}

function orderFields(schema: DocumentSchema, fields: Map<string, ExtractedField>): ExtractedField[] {
  const known = schema.fields.map((s) => fields.get(s.key)!).filter(Boolean);
  const extra = [...fields.values()].filter((f) => !schema.fields.some((s) => s.key === f.key));
  return [...known, ...extra];
}

async function readMrz(
  rows: RowText[],
  image: PageImage | null,
  engines: PlatformEngines,
): Promise<{ result: MrzResult; evidence?: FieldEvidence } | null> {
  const fromRows = (rs: RowText[]) => {
    const r = extractMrz(rs.map((row) => row.compact));
    if (!r) return null;
    // Evidence: every MRZ-looking row (all two or three lines), not just the first match.
    const used = rs.filter(isMrzLike);
    const evidence = used.length
      ? { page: used[0]!.page, bbox: unionBox(used.map((u) => (u.rect ? rotatedBounds(u.rect) : u.bbox))) }
      : undefined;
    return { result: r, ...(evidence ? { evidence } : {}) };
  };
  const better = (a: ReturnType<typeof fromRows>, b: ReturnType<typeof fromRows>) => {
    if (!a) return b;
    if (!b) return a;
    if (a.result.valid !== b.result.valid) return a.result.valid ? a : b;
    return b.result.invalidFields.length < a.result.invalidFields.length ? b : a;
  };

  let best = fromRows(rows);
  if (best?.result.valid || !image) return best;
  const engine = engines.mrzOcr ?? engines.ocr;

  // Pass 2: complete MRZ-looking rows whose trailing fillers were missed.
  best = better(best, await completeMrzRows(rows, image, engine));
  if (best?.result.valid) return best;

  // Pass 3: OCR only the MRZ band with the MRZ alphabet — as captured and
  // contrast-enhanced — then pick the best line-by-line combination.
  const top = Math.floor(image.height * MRZ_BAND.top);
  const band = cropImage(image, { x: 0, y: top, w: image.width, h: Math.ceil(image.height * MRZ_BAND.height) });
  const candidates: RowText[] = [];
  try {
    for (const variant of ["captured", "enhanced"] as const) {
      const img = variant === "captured" ? band : enhanceContrast(band);
      const found = await engine.recognize(img, { charWhitelist: MRZ_CHARSET, layout: "band" });
      if (img !== band) wipeImage(img);
      const shifted = rowTexts(
        found.map((l) => ({
          ...l,
          page: image.page,
          bbox: { ...l.bbox, y: l.bbox.y + top },
          ...(l.rect ? { rect: { ...l.rect, y: l.rect.y + top } } : {}),
        })),
      );
      candidates.push(...shifted.filter(isMrzLike));
      best = better(best, bestCombination(candidates));
      if (best?.result.valid) return best;
    }
  } finally {
    wipeImage(band);
  }
  return better(best, await completeMrzRows(candidates, image, engine));

  /** Cluster candidate rows into MRZ line slots by height and try the combinations. */
  function bestCombination(rs: RowText[]) {
    const slots: RowText[][] = [];
    for (const r of [...rs].sort((a, b) => a.bbox.y - b.bbox.y)) {
      const cy = r.bbox.y + r.bbox.h / 2;
      const slot = slots.find((s) => Math.abs(s[0]!.bbox.y + s[0]!.bbox.h / 2 - cy) < s[0]!.bbox.h * 0.6);
      if (slot) slot.push(r);
      else slots.push([r]);
    }
    let found: ReturnType<typeof fromRows> = null;
    for (let i = 0; i < slots.length; i++) {
      for (const n of [2, 3]) {
        const group = slots.slice(i, i + n);
        if (group.length !== n) continue;
        for (const combo of product(group.map((s) => s.slice(0, 3)))) {
          found = better(found, fromRows(combo));
          if (found?.result.valid) return found;
        }
      }
    }
    return found;
  }

  async function completeMrzRows(rs: RowText[], img: PageImage, eng: OcrEngine) {
    if (!eng.recognizeRegion) return null;
    const mrzRows = rs.filter(isMrzLike);
    if (!mrzRows.length) return null;
    let found: ReturnType<typeof fromRows> = null;
    for (const target of [44, 36, 30]) {
      const completed: RowText[] = [];
      for (const row of mrzRows) {
        const len = normalizeForMatch(row.compact).length;
        if (len > target) continue;
        // OCR-B is monospaced: keep the line's left end fixed and extend it
        // along the text direction to the expected number of characters.
        const r0 = row.rect ?? { ...row.bbox, angle: 0 };
        const pitch = r0.w / len;
        const newW = pitch * (target + 1.5);
        const cos = Math.cos(r0.angle);
        const sin = Math.sin(r0.angle);
        const cx = r0.x + r0.w / 2;
        const cy = r0.y + r0.h / 2;
        const leftX = cx - (r0.w / 2) * cos - pitch * 0.5 * cos;
        const leftY = cy - (r0.w / 2) * sin - pitch * 0.5 * sin;
        const ncx = leftX + (newW / 2) * cos;
        const ncy = leftY + (newW / 2) * sin;
        const h = r0.h * 1.25;
        const box = { x: ncx - newW / 2, y: ncy - h / 2, w: newW, h, angle: r0.angle };
        const r = await eng.recognizeRegion!(img, box, { charWhitelist: MRZ_CHARSET, layout: "band" });
        completed.push({ ...row, text: r.text, compact: r.text, bbox: rotatedBounds(box), rect: box, confidence: r.confidence });
      }
      found = better(found, fromRows(completed));
      if (found?.result.valid) break;
    }
    return found;
  }
}

function isMrzLike(r: RowText): boolean {
  const t = normalizeForMatch(r.compact);
  return t.length >= 20 && /<{2,}/.test(t);
}

function* product<T>(lists: T[][]): Generator<T[]> {
  if (!lists.length) {
    yield [];
    return;
  }
  for (const head of lists[0]!) for (const tail of product(lists.slice(1))) yield [head, ...tail];
}

function normalizeForMatch(s: string): string {
  return s.toUpperCase().replace(/[«»]/g, "<<").replace(/[^A-Z0-9<]/g, "");
}

const MRZ_FIELD_MAP: Record<string, { mrz: keyof MrzResult["fields"]; checkDigit: boolean }> = {
  document_number: { mrz: "documentNumber", checkDigit: true },
  surname: { mrz: "lastName", checkDigit: false },
  given_names: { mrz: "firstName", checkDigit: false },
  nationality: { mrz: "nationality", checkDigit: false },
  date_of_birth: { mrz: "birthDate", checkDigit: true },
  sex: { mrz: "sex", checkDigit: false },
  date_of_expiry: { mrz: "expirationDate", checkDigit: true },
  issuing_country: { mrz: "issuingState", checkDigit: false },
  personal_number: { mrz: "personalNumber", checkDigit: true },
};

/**
 * Map MRZ fields. Only fields protected by their own check digit (and the
 * composite) count as validated; names are NOT covered by any MRZ check
 * digit, so they are validated only by the visual-zone cross-check.
 */
function applyMrz(
  schema: DocumentSchema,
  mrz: MrzResult,
  evidence: FieldEvidence | undefined,
  fields: Map<string, ExtractedField>,
  checks: CheckResult[],
) {
  const compositeOk = !mrz.invalidFields.includes("compositeCheckDigit");
  for (const spec of schema.fields) {
    const map = MRZ_FIELD_MAP[spec.key];
    if (!map) continue;
    const raw = mrz.fields[map.mrz]?.trim() ?? null;
    const fieldOk = !mrz.invalidFields.some((f) => f.startsWith(map.mrz));
    const value = raw === null || raw === "" ? null : raw;
    // Code-list fields (country, sex) carry no check digit of their own; they
    // count as validated only when every MRZ check passes, i.e. the line was
    // read and aligned correctly.
    const validated = value !== null && fieldOk && (map.checkDigit ? compositeOk : isEnumerated(spec.key) && mrz.valid);
    const validatedBy = validated ? [map.checkDigit ? "mrz.check_digits" : "mrz.vocabulary"] : [];
    fields.set(spec.key, {
      key: spec.key,
      label: spec.label,
      value,
      source: "mrz",
      confidence: fieldOk ? 0.99 : 0.4,
      validated,
      validatedBy,
      needsReview: false,
      userEdited: false,
      required: spec.required ?? false,
      ...(evidence ? { evidence } : {}),
    });
  }
  checks.push({
    id: "mrz.check_digits",
    ok: mrz.valid,
    message: mrz.valid
      ? `All MRZ check digits pass (${mrz.format})`
      : `MRZ check failed for: ${mrz.invalidFields.join(", ")}`,
    fields: mrz.valid
      ? ["document_number", "date_of_birth", "date_of_expiry"]
      : Object.entries(MRZ_FIELD_MAP)
          .filter(([, m]) => mrz.invalidFields.some((f) => f.startsWith(m.mrz)))
          .map(([k]) => k),
  });
}

/** Country codes and sex come from closed vocabularies the parser enforces. */
function isEnumerated(key: string): boolean {
  return key === "nationality" || key === "issuing_country" || key === "sex";
}

/**
 * Visual-zone cross-check: the printed (non-MRZ) part of the document must
 * show the same value. Agreement between two independent readings is what
 * validates the names (no MRZ check digit covers them). To count, the MRZ
 * must pass all its checks (so it was aligned correctly) and the value must
 * match the printed field with the same label — not just appear somewhere
 * on the page (a given name is not a surname).
 */
function vizCrossCheck(mrz: MrzResult, rows: RowText[], lines: TextLine[], fields: Map<string, ExtractedField>): CheckResult[] {
  const vizRows = rows.filter((r) => !/<{2,}/.test(r.compact));
  if (!vizRows.length) return [];
  const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const vizText = ` ${vizRows.map((r) => norm(r.text)).join(" ")} `;
  const vizLines = lines.filter((l) => !/<{2,}/.test(l.text));
  const out: CheckResult[] = [];
  const pairs: [string, string | null][] = [
    ["surname", mrz.fields.lastName],
    ["given_names", mrz.fields.firstName],
    ["document_number", mrz.fields.documentNumber],
  ];
  for (const [key, value] of pairs) {
    if (!value) continue;
    const needle = norm(value);
    let ok = false;
    if (mrz.valid && needle.length > 1) {
      const anchors = PRINTED_NAME_ANCHORS[key];
      const printed = anchors ? findByAnchors(vizLines, anchors, "name") : null;
      if (printed) ok = norm(printed.value) === needle;
      else if (key === "document_number") ok = vizText.replace(/ /g, "").includes(needle.replace(/ /g, ""));
      else ok = false; // no labelled printed name to compare against
    }
    out.push({
      id: `mrz.viz_match.${key}`,
      ok,
      message: ok ? `${key.replace("_", " ")} matches the printed page` : `${key.replace("_", " ")} could not be matched to the printed page`,
      fields: [key],
    });
    const f = fields.get(key);
    if (ok && f && f.value !== null) f.validatedBy.push(`mrz.viz_match.${key}`);
  }
  return out;
}

const PRINTED_NAME_ANCHORS: Record<string, RegExp[]> = {
  surname: [/\b(?:surname|last name|family name|nom|apellidos|nachname)\b/i],
  given_names: [/\b(?:given names?|first names?|pr[ée]noms?|nombres?|vornamen?)\b/i],
};

/**
 * Names are not protected by any MRZ check digit. When the MRZ names do not
 * match the printed page, offer the printed (visual zone) reading instead —
 * still flagged for review, since neither reading is verified.
 */
function preferPrintedNames(lines: TextLine[], fields: Map<string, ExtractedField>, dateOrder?: DateOrder) {
  for (const [key, anchors] of Object.entries(PRINTED_NAME_ANCHORS)) {
    const f = fields.get(key);
    if (!f || f.validatedBy.some((v) => v.startsWith("mrz.viz_match"))) continue;
    const printed = findByAnchors(lines, anchors, "name", dateOrder ? { dateOrder } : {});
    if (!printed) continue;
    f.value = printed.value.toUpperCase();
    f.source = "ocr";
    f.confidence = printed.confidence;
    f.evidence = printed.evidence;
    f.validatedBy = [];
  }
}

/**
 * Re-run the schema's deterministic checks and recompute review flags.
 * Called at the end of extraction (with the page lines) and after every user
 * edit (without them — the text is not kept around after extraction).
 */
export function finalizeReview(result: ExtractionResult, lines: TextLine[] = [], threshold = 0.9): void {
  const schema = getSchema(result.docType);
  const map = new Map(result.fields.map((f) => [f.key, f]));
  const fresh = schema.checks?.(map, { lines }) ?? [];
  result.checks = [...result.checks.filter((c) => isReadingCheck(c.id)), ...fresh];

  for (const f of result.fields) {
    const reading = f.userEdited ? [] : f.validatedBy.filter(isReadingCheck);
    const derived = fresh.filter((c) => c.ok && c.fields.includes(f.key)).map((c) => c.id);
    f.validatedBy = f.value === null ? [] : [...new Set([...reading, ...derived])];
    f.validated = f.validatedBy.length > 0;
  }

  const implicated = new Set(result.checks.filter((c) => !c.ok).flatMap((c) => c.fields));
  for (const f of result.fields) {
    if (f.value === null) {
      f.needsReview = f.required;
    } else if (f.userEdited) {
      f.needsReview = implicated.has(f.key);
    } else {
      // Only exact text-layer reads may skip review without a check vouching for them.
      f.needsReview = implicated.has(f.key) || (!f.validated && (f.source !== "text_layer" || f.confidence < threshold));
    }
  }
}

/**
 * Checks produced while reading the document (MRZ, IBAN, table rows). They
 * survive re-checks after user edits; schema checks are recomputed.
 */
function isReadingCheck(id: string): boolean {
  return id.startsWith("mrz.") || id.startsWith("iban.") || id.startsWith("rows.");
}
