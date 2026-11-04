import { extractDocument, type DocumentInput, type ExtractionResult, type PlatformEngines } from "@pde/core";
import { payslipPdf, payslipPhoto, randomPassport, randomPayslip, randomStatement, renderPassportPhoto, statementPdf } from "../../../bench/synth.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeEngines } from "../src/node.ts";

/** Real OCR models, real pdf.js, synthetic documents. */
let engines: PlatformEngines & { dispose(): Promise<void> };
beforeAll(async () => {
  engines = await createNodeEngines();
}, 60_000);
afterAll(() => engines?.dispose());

const input = (bytes: Uint8Array | Buffer, mime: string, name: string): DocumentInput => ({
  name,
  mime,
  bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
});
const values = (r: ExtractionResult) => Object.fromEntries(r.fields.map((f) => [f.key, f.value]));

describe("end-to-end extraction (Node, real models)", () => {
  it("passport photo: MRZ read and validated", async () => {
    const p = randomPassport(7);
    const r = await extractDocument(input(renderPassportPhoto(p), "image/png", "p.png"), engines, { docType: "passport" });
    expect(r.checks.find((c) => c.id === "mrz.check_digits")?.ok).toBe(true);
    expect(values(r)).toMatchObject(p.truth);
    expect(r.fields.find((f) => f.key === "document_number")?.validated).toBe(true);
  }, 120_000);

  it("rotated, noisy passport photo still validates", async () => {
    const p = randomPassport(11);
    const png = renderPassportPhoto(p, { rotate: 1.5, noise: 18, seed: 3 });
    const r = await extractDocument(input(png, "image/png", "p.png"), engines, { docType: "passport" });
    expect(r.checks.find((c) => c.id === "mrz.check_digits")?.ok).toBe(true);
    expect(values(r)).toMatchObject({ document_number: p.truth.document_number, date_of_birth: p.truth.date_of_birth });
  }, 120_000);

  it("digital payslip PDF: text layer only, arithmetic reconciles", async () => {
    const p = randomPayslip(5);
    const r = await extractDocument(input(await payslipPdf(p), "application/pdf", "slip.pdf"), engines, { docType: "payslip", previewSide: 0 });
    expect(r.sourcesUsed).toEqual(["text_layer"]);
    expect(values(r)).toMatchObject(p.truth);
    expect(r.fields.filter((f) => f.needsReview)).toEqual([]);
  }, 60_000);

  it("photographed payslip: OCR + arithmetic", async () => {
    const p = randomPayslip(9);
    const r = await extractDocument(input(payslipPhoto(p, { noise: 10, seed: 2 }), "image/png", "slip.png"), engines, { docType: "payslip" });
    expect(values(r)).toMatchObject({ gross_pay: p.truth.gross_pay, total_deductions: p.truth.total_deductions, net_pay: p.truth.net_pay });
    expect(r.checks.find((c) => c.id.startsWith("payslip."))?.ok).toBe(true);
  }, 120_000);

  it("digital bank statement PDF: summary, IBAN and running balance", async () => {
    const s = randomStatement(4);
    const r = await extractDocument(input(await statementPdf(s), "application/pdf", "st.pdf"), engines, { docType: "bank_statement", previewSide: 0 });
    expect(values(r)).toMatchObject(s.truth);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.map((c) => c.id)).toContain("rows.running_balance");
  }, 60_000);
});
