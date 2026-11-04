import type { ValueKind } from "../mapping.ts";
import type { CheckResult, DocType, ExtractedField, TextLine } from "../types.ts";

export interface FieldSpec {
  key: string;
  label: string;
  kind: ValueKind;
  /** Printed labels to look for; tried in order. Empty for MRZ-only fields. */
  anchors: RegExp[];
  required?: boolean;
}

export interface SchemaContext {
  lines: TextLine[];
}

export interface DocumentSchema {
  type: DocType;
  label: string;
  fields: FieldSpec[];
  /** Read the MRZ for this document type. */
  usesMrz?: boolean;
  /**
   * Deterministic cross-field checks. Must only look at field values so it
   * can be re-run after the user edits a field in review.
   */
  checks?(fields: Map<string, ExtractedField>, ctx: SchemaContext): CheckResult[];
}
