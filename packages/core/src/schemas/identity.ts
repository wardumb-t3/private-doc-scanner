import type { DocumentSchema, FieldSpec } from "./types.ts";

/** Fields read from the MRZ of passports (TD3) and ID cards (TD1/TD2). */
const MRZ_FIELDS: FieldSpec[] = [
  { key: "document_number", label: "Document number", kind: "id", anchors: [], required: true },
  { key: "surname", label: "Surname", kind: "name", anchors: [], required: true },
  { key: "given_names", label: "Given names", kind: "name", anchors: [], required: true },
  { key: "nationality", label: "Nationality", kind: "text", anchors: [], required: true },
  { key: "date_of_birth", label: "Date of birth", kind: "date", anchors: [], required: true },
  { key: "sex", label: "Sex", kind: "text", anchors: [] },
  { key: "date_of_expiry", label: "Date of expiry", kind: "date", anchors: [], required: true },
  { key: "issuing_country", label: "Issuing country", kind: "text", anchors: [], required: true },
  { key: "personal_number", label: "Personal number", kind: "id", anchors: [] },
];

function expiryCheck(fields: Parameters<NonNullable<DocumentSchema["checks"]>>[0]) {
  const expiry = fields.get("date_of_expiry")?.value;
  if (!expiry) return [];
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      id: "document.not_expired",
      ok: expiry >= today,
      message: expiry >= today ? "Document is not expired" : `Document expired on ${expiry}`,
      fields: ["date_of_expiry"],
    },
  ];
}

export const passportSchema: DocumentSchema = {
  type: "passport",
  label: "Passport",
  usesMrz: true,
  fields: MRZ_FIELDS,
  checks: expiryCheck,
};

export const idCardSchema: DocumentSchema = {
  type: "id_card",
  label: "ID card",
  usesMrz: true,
  fields: MRZ_FIELDS,
  checks: expiryCheck,
};
