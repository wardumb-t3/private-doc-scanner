import { wipeImage } from "./image.ts";
import { finalizeReview } from "./pipeline.ts";
import type { ExtractionResult } from "./types.ts";

/**
 * Apply a user correction from the review screen. The value becomes
 * user-sourced, loses any validation that came from reading the document
 * and the schema's cross-field checks are re-run on the new values.
 */
export function applyUserEdit(result: ExtractionResult, key: string, value: string): void {
  const field = result.fields.find((f) => f.key === key);
  if (!field) throw new Error(`unknown field: ${key}`);
  const next = value.trim();
  if ((field.value ?? "") === next) return;
  field.value = next === "" ? null : next;
  field.source = "user";
  field.userEdited = true;
  field.confidence = 1;
  finalizeReview(result);
}

/** Fields the user must look at before the submit button is enabled. */
export function fieldsNeedingReview(result: ExtractionResult): string[] {
  return result.fields.filter((f) => f.needsReview).map((f) => f.key);
}

/** Wipe preview pixels kept for the review screen. */
export function releaseResult(result: ExtractionResult): void {
  for (const p of result.previews) wipeImage(p);
  result.previews = [];
}
