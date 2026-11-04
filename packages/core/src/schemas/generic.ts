import type { DocumentSchema } from "./types.ts";

/** Unknown document: fields come from `Label: value` pairs; all need review. */
export const genericSchema: DocumentSchema = {
  type: "generic",
  label: "Other document",
  fields: [],
};
