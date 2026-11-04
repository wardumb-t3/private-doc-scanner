import type { DocType, FieldSource } from "@pde/core";

export const DOC_LABELS: Record<DocType, { title: string; hint: string; photoFirst: boolean }> = {
  passport: { title: "Passport", hint: "The photo page, with the two lines of <<< at the bottom fully visible.", photoFirst: true },
  id_card: { title: "ID card", hint: "The side with the lines of <<< (usually the back).", photoFirst: true },
  payslip: { title: "Payslip", hint: "The PDF from your employer works best. A photo of a printed payslip also works.", photoFirst: false },
  bank_statement: { title: "Bank statement", hint: "Download the PDF from your bank's app or website for the most accurate result.", photoFirst: false },
  generic: { title: "Other document", hint: "A PDF or a clear photo.", photoFirst: false },
};

export const SOURCE_LABELS: Record<FieldSource, string> = {
  text_layer: "Read from the PDF text",
  barcode: "Read from the barcode",
  mrz: "Read from the machine-readable lines",
  ocr: "Read from the image",
  user: "Entered by you",
};

/** Human wording for passed check ids (never includes values). */
export function checkLabel(id: string): string {
  if (id === "mrz.check_digits") return "Check digits on the document match";
  if (id.startsWith("mrz.viz_match.")) return "Matches the printed page";
  if (id === "mrz.vocabulary") return "Valid country / sex code";
  if (id === "iban.mod97") return "IBAN checksum is valid";
  if (id === "payslip.gross_minus_deductions_equals_net") return "Gross − deductions = net";
  if (id === "statement.opening_plus_in_minus_out_equals_closing") return "Balances add up";
  if (id === "rows.running_balance") return "Transaction balances add up";
  if (id === "document.not_expired") return "Not expired";
  return id;
}
