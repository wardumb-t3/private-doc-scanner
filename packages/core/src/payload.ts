import type { CheckResult, DocType, ExtractionResult, FieldSource } from "./types.ts";

export const SUBMISSION_SCHEMA = "pde.submission/v1";

export interface SubmittedField {
  value: string;
  source: FieldSource;
  validated: boolean;
  validated_by: string[];
  user_edited: boolean;
}

export interface SubmittedDocument {
  doc_type: DocType;
  fields: Record<string, SubmittedField>;
  checks: Pick<CheckResult, "id" | "ok">[];
}

/**
 * The only thing that ever leaves the device. Contains the reviewed field
 * values and how each was obtained — no images, no page text, no file name,
 * no check messages (which can echo values), no device fingerprint.
 */
export interface Submission {
  schema: typeof SUBMISSION_SCHEMA;
  request_id: string | null;
  documents: SubmittedDocument[];
  client: { name: string; version: string; engine: string };
  created_at: string;
}

export function buildSubmission(input: {
  requestId: string | null;
  results: ExtractionResult[];
  client: Submission["client"];
  now?: Date;
}): Submission {
  return {
    schema: SUBMISSION_SCHEMA,
    request_id: input.requestId,
    documents: input.results.map((r) => ({
      doc_type: r.docType,
      fields: Object.fromEntries(
        r.fields
          .filter((f) => f.value !== null)
          .map((f) => [
            f.key,
            {
              value: f.value!,
              source: f.source,
              validated: f.validated,
              validated_by: [...f.validatedBy],
              user_edited: f.userEdited,
            },
          ]),
      ),
      checks: r.checks.map((c) => ({ id: c.id, ok: c.ok })),
    })),
    client: input.client,
    created_at: (input.now ?? new Date()).toISOString(),
  };
}

/** Field names only (no values) — safe to show on the seal-confirmation screen or log. */
export function describeSubmission(s: Submission): { doc_type: DocType; fields: string[] }[] {
  return s.documents.map((d) => ({ doc_type: d.doc_type, fields: Object.keys(d.fields) }));
}
