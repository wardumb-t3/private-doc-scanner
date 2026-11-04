import { composeTd3 } from "@pde/validators";
import { describe, expect, it } from "vitest";
import {
  applyUserEdit,
  buildSubmission,
  extractDocument,
  fieldsNeedingReview,
  releaseResult,
  type ExtractionResult,
} from "../src/index.ts";
import { JPG, PDF, engines, fakeOcr, linesFrom } from "./helpers.ts";

const field = (r: ExtractionResult, key: string) => r.fields.find((f) => f.key === key)!;

const PAYSLIP = [
  "ACME Widgets Ltd",
  "PAYSLIP",
  "Employer: ACME Widgets Ltd",
  "Employee Name: Jane Q Public | Employee ID: E-10442",
  "Pay Period: 01/03/2025 - 31/03/2025 | Pay Date: 28 Mar 2025",
  "Earnings | Amount",
  "Basic Salary | 4,500.00",
  "Overtime | 500.00",
  "Gross Pay | 5,000.00",
  "Income Tax | 750.25",
  "Pension | 249.75",
  "Total Deductions | 1,000.00",
  "Net Pay | 4,000.00",
];

describe("payslip from a digital PDF", () => {
  it("reads every field from the text layer and reconciles the arithmetic", async () => {
    const ocr = fakeOcr("ocr", () => []);
    const r = await extractDocument(PDF, engines({ text: [{ page: 1, width: 800, height: 600, source: "text_layer", lines: linesFrom(PAYSLIP) }], ocr }), {
      docType: "payslip",
      previewSide: 0,
    });
    expect(ocr.calls).toBe(0); // text layer only — no OCR needed
    expect(field(r, "employer_name").value).toBe("ACME Widgets Ltd");
    expect(field(r, "employee_name").value).toBe("Jane Q Public");
    expect(field(r, "employee_id").value).toBe("E-10442");
    expect(field(r, "pay_period").value).toBe("2025-03-01/2025-03-31");
    expect(field(r, "pay_date").value).toBe("2025-03-28");
    expect(field(r, "gross_pay").value).toBe("5000.00");
    expect(field(r, "total_deductions").value).toBe("1000.00");
    expect(field(r, "net_pay").value).toBe("4000.00");
    expect(r.checks.find((c) => c.id === "payslip.gross_minus_deductions_equals_net")?.ok).toBe(true);
    expect(field(r, "net_pay").validated).toBe(true);
    expect(field(r, "net_pay").source).toBe("text_layer");
    expect(fieldsNeedingReview(r)).toEqual([]);
  });

  it("flags the amounts when the arithmetic does not reconcile, and re-checks after an edit", async () => {
    const misread = PAYSLIP.map((l) => (l.startsWith("Net Pay") ? "Net Pay | 4,900.00" : l));
    const r = await extractDocument(PDF, engines({ text: [{ page: 1, width: 800, height: 600, source: "text_layer", lines: linesFrom(misread) }] }), {
      docType: "payslip",
      previewSide: 0,
    });
    expect(r.checks.find((c) => c.id.startsWith("payslip."))?.ok).toBe(false);
    expect(fieldsNeedingReview(r)).toEqual(expect.arrayContaining(["gross_pay", "total_deductions", "net_pay"]));

    applyUserEdit(r, "net_pay", "4000.00");
    expect(r.checks.find((c) => c.id.startsWith("payslip."))?.ok).toBe(true);
    expect(field(r, "net_pay")).toMatchObject({ source: "user", userEdited: true, validated: true });
    expect(fieldsNeedingReview(r)).toEqual([]);
  });

  it("falls back to OCR for scanned pages without a text layer", async () => {
    const ocr = fakeOcr("ocr", () => linesFrom(PAYSLIP, "ocr", 0.97));
    const r = await extractDocument(PDF, engines({ text: [{ page: 1, width: 800, height: 600, source: "text_layer", lines: [] }], ocr }), {
      docType: "payslip",
    });
    expect(ocr.calls).toBe(1);
    expect(field(r, "net_pay")).toMatchObject({ value: "4000.00", source: "ocr", validated: true });
    // OCR'd text fields without a check need a human look.
    expect(field(r, "employer_name").needsReview).toBe(true);
    expect(r.previews).toHaveLength(1);
    releaseResult(r);
    expect(r.previews).toHaveLength(0);
  });
});

describe("bank statement", () => {
  const STATEMENT = [
    "Example Bank plc",
    "Account Holder: John Smith",
    "IBAN: GB82 WEST 1234 5698 7654 32",
    "Statement Period: 1 Mar 2025 to 31 Mar 2025",
    "Opening Balance | 1,000.00",
    "Date | Description | Amount | Balance",
    "03/03/2025 | Salary ACME | 2,500.00 | 3,500.00",
    "05/03/2025 | Grocer | 120.50 | 3,379.50",
    "09/03/2025 | Utilities | 79.50 | 3,300.00",
    "Total Money In | 2,500.00",
    "Total Money Out | 200.00",
    "Closing Balance | 3,300.00",
  ];

  it("extracts summary fields, validates the IBAN and the balance chain", async () => {
    const r = await extractDocument(PDF, engines({ text: [{ page: 1, width: 800, height: 600, source: "text_layer", lines: linesFrom(STATEMENT) }] }), {
      docType: "bank_statement",
      previewSide: 0,
    });
    expect(field(r, "account_holder").value).toBe("John Smith");
    expect(field(r, "iban")).toMatchObject({ value: "GB82WEST12345698765432", validated: true });
    expect(field(r, "statement_period").value).toBe("2025-03-01/2025-03-31");
    expect(field(r, "opening_balance").value).toBe("1000.00");
    expect(field(r, "closing_balance").value).toBe("3300.00");
    expect(r.checks.find((c) => c.id === "statement.opening_plus_in_minus_out_equals_closing")?.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "rows.running_balance")?.ok).toBe(true);
    expect(fieldsNeedingReview(r)).toEqual([]);
  });

  it("keeps the row check after an edit even though page text is gone", async () => {
    const r = await extractDocument(PDF, engines({ text: [{ page: 1, width: 800, height: 600, source: "text_layer", lines: linesFrom(STATEMENT) }] }), {
      docType: "bank_statement",
      previewSide: 0,
    });
    applyUserEdit(r, "account_holder", "John A Smith");
    expect(r.checks.filter((c) => c.id === "rows.running_balance")).toHaveLength(1);
  });
});

describe("passport photo", () => {
  const mrz = composeTd3({
    issuingState: "NLD",
    lastName: "De Vries",
    firstName: "Sanne",
    documentNumber: "SPECI2021",
    nationality: "NLD",
    birthDate: "900310",
    sex: "F",
    expirationDate: "310802",
  });
  const viz = ["KONINKRIJK DER NEDERLANDEN", "PASPOORT", "Surname DE VRIES", "Given names SANNE", "Document no SPECI2021"];

  it("reads and validates the MRZ, cross-checks names against the printed page", async () => {
    const ocr = fakeOcr("ocr", () => linesFrom([...viz, mrz[0], mrz[1]], "ocr", 0.93));
    const r = await extractDocument(JPG, engines({ ocr }), { docType: "passport" });
    expect(r.checks.find((c) => c.id === "mrz.check_digits")?.ok).toBe(true);
    expect(field(r, "document_number")).toMatchObject({ value: "SPECI2021", source: "mrz", validated: true });
    expect(field(r, "date_of_birth").value).toBe("1990-03-10");
    expect(field(r, "date_of_expiry").value).toBe("2031-08-02");
    expect(field(r, "surname")).toMatchObject({ value: "DE VRIES", validated: true });
    expect(field(r, "surname").validatedBy).toContain("mrz.viz_match.surname");
    expect(fieldsNeedingReview(r)).toEqual([]);
  });

  it("re-reads only the MRZ band with the MRZ alphabet when the first read fails", async () => {
    // A wrong digit in the birth date: no autocorrect or repair can fix it, only a re-read.
    const garbled = [mrz[0], mrz[1].replace("900310", "900410")];
    const ocr = fakeOcr("ocr", () => linesFrom([...viz, garbled[0]!, garbled[1]!], "ocr", 0.8));
    const band = fakeOcr("mrz", (_img, opts) => {
      expect(opts?.charWhitelist).toContain("<");
      return linesFrom([mrz[0], mrz[1]], "ocr", 0.95);
    });
    const r = await extractDocument(JPG, engines({ ocr, mrzOcr: band }), { docType: "passport" });
    expect(band.calls).toBe(1);
    expect(r.checks.find((c) => c.id === "mrz.check_digits")?.ok).toBe(true);
    expect(field(r, "document_number").value).toBe("SPECI2021");
  });

  it("warns when no MRZ is visible and asks the user for the required fields", async () => {
    const ocr = fakeOcr("ocr", () => linesFrom(viz, "ocr", 0.9));
    const r = await extractDocument(JPG, engines({ ocr }), { docType: "passport" });
    expect(r.warnings.join(" ")).toMatch(/machine-readable zone/);
    expect(fieldsNeedingReview(r)).toEqual(expect.arrayContaining(["document_number", "date_of_birth"]));
  });

  it("drops reading-based validation when the user edits an MRZ field", async () => {
    const ocr = fakeOcr("ocr", () => linesFrom([...viz, mrz[0], mrz[1]], "ocr", 0.93));
    const r = await extractDocument(JPG, engines({ ocr }), { docType: "passport" });
    applyUserEdit(r, "document_number", "SPECI2022");
    expect(field(r, "document_number")).toMatchObject({ validated: false, source: "user" });
  });
});

describe("submission payload", () => {
  it("contains reviewed values only — no page text, images or file names", async () => {
    const SECRET = "Confidential footer text that must never leave";
    const lines = linesFrom([...PAYSLIP, SECRET]);
    const r = await extractDocument(PDF, engines({ text: [{ page: 1, width: 800, height: 600, source: "text_layer", lines }] }), {
      docType: "payslip",
    });
    const s = buildSubmission({
      requestId: "req_123",
      results: [r],
      client: { name: "private-doc-scanner", version: "0.1.0", engine: "test" },
      now: new Date("2025-04-01T00:00:00Z"),
    });
    const json = JSON.stringify(s);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("doc.pdf");
    expect(json).not.toContain("previews");
    expect(json).not.toContain("bbox");
    expect(s.documents[0]!.fields.net_pay).toEqual({
      value: "4000.00",
      source: "text_layer",
      validated: true,
      validated_by: ["payslip.gross_minus_deductions_equals_net"],
      user_edited: false,
    });
    expect(s.request_id).toBe("req_123");
  });
});
