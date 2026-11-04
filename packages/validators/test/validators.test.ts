import { describe, expect, it } from "vitest";
import {
  checkPayslip,
  checkStatementBalance,
  extractMrz,
  isValidIban,
  isValidLuhn,
  mrzCheckDigit,
  parseAmount,
  parseDate,
  parseMrz,
  composeTd3,
} from "../src/index.ts";

// Synthetic passport with valid check digits (real state code so the
// parser's state-code validation passes; the ICAO "UTO" specimen does not).
const TD3 = composeTd3({
  issuingState: "NLD",
  lastName: "Eriksson",
  firstName: "Anna Maria",
  documentNumber: "L898902C3",
  nationality: "NLD",
  birthDate: "740812",
  sex: "F",
  expirationDate: "340415",
  personalNumber: "ZE184226B",
});
// ICAO 9303 part 5 TD1 layout, state code swapped from UTO to NLD
// (check digits do not cover the state code).
const TD1 = [
  "I<NLDD231458907<<<<<<<<<<<<<<<",
  "7408122F1204159NLD<<<<<<<<<<<6",
  "ERIKSSON<<ANNA<MARIA<<<<<<<<<<",
];

describe("check digits", () => {
  it("computes ICAO 9303 check digits", () => {
    expect(mrzCheckDigit("L898902C3")).toBe(6);
    expect(mrzCheckDigit("740812")).toBe(2);
    expect(mrzCheckDigit("120415")).toBe(9);
    expect(mrzCheckDigit("ZE184226B<<<<<")).toBe(1);
  });
  it("validates Luhn", () => {
    expect(isValidLuhn("4539 1488 0343 6467")).toBe(true);
    expect(isValidLuhn("4539 1488 0343 6468")).toBe(false);
  });
  it("validates IBAN", () => {
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("GB82WEST12345698765433")).toBe(false);
    expect(isValidIban("GB82WEST123456987654")).toBe(false); // wrong length
  });
});

describe("MRZ", () => {
  it("parses a valid TD3 passport", () => {
    const r = parseMrz(TD3)!;
    expect(r.format).toBe("TD3");
    expect(r.valid).toBe(true);
    expect(r.fields).toMatchObject({
      documentNumber: "L898902C3",
      lastName: "ERIKSSON",
      firstName: "ANNA MARIA",
      nationality: "NLD",
      birthDate: "1974-08-12",
      expirationDate: "2034-04-15",
      sex: "female",
    });
  });

  it("parses a valid TD1 ID card", () => {
    const r = parseMrz(TD1)!;
    expect(r.format).toBe("TD1");
    expect(r.valid).toBe(true);
    expect(r.fields.documentNumber).toBe("D23145890");
  });

  it("finds MRZ inside noisy OCR output and repairs fillers", () => {
    const ocr = [
      "PASSPORT",
      "Surname / Nom ERIKSSON",
      "P<NLDERIKSSON<<ANNA<MARIA«<<<<<<<<<<<<<<<<",
      TD3[1].replace(/<<<<<1/, "<<<< <1"),
    ];
    const r = extractMrz(ocr)!;
    expect(r.valid).toBe(true);
    expect(r.fields.lastName).toBe("ERIKSSON");
  });

  it("pads the names line when OCR drops its trailing fillers", () => {
    const r = extractMrz(["P<NLDERIKSSON<<ANNA<MARIA<<<<", TD3[1]])!;
    expect(r.valid).toBe(true);
    expect(r.fields.firstName).toBe("ANNA MARIA");
  });

  it("widens filler runs shortened by CTC decoding", () => {
    const short = TD3[1].replace(/<{5}/, "<<");
    const r = extractMrz([TD3[0], short])!;
    expect(r.format).toBe("TD3");
    expect(r.valid).toBe(true);
  });

  it("autocorrects O/0 in numeric fields and still validates", () => {
    const noisy = [TD3[0]!, TD3[1].replace("7408122", "74O8122")];
    const r = parseMrz(noisy)!;
    expect(r.valid).toBe(true);
    expect(r.autocorrected).toBeGreaterThan(0);
  });

  it("repairs O/0 confusion in the alphanumeric document number using two check digits", () => {
    const r = parseMrz([TD3[0], TD3[1].replace("L898902C3", "L8989O2C3")])!;
    expect(r.valid).toBe(true);
    expect(r.fields.documentNumber).toBe("L898902C3");
    expect(r.autocorrected).toBe(1);
  });

  it("flags a misread digit via the check digit", () => {
    const bad = [TD3[0]!, TD3[1].replace("7408122", "7408132")];
    const r = parseMrz(bad)!;
    expect(r.valid).toBe(false);
    expect(r.invalidFields.some((f) => f.startsWith("birthDate"))).toBe(true);
  });
});

describe("amounts", () => {
  it.each([
    ["1,234.56", 1234.56],
    ["1.234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["$1,234", 1234],
    ["(45.00)", -45],
    ["-12.5", -12.5],
    ["99.99-", -99.99],
    ["250.00 DR", -250],
    ["250.00 CR", 250],
    ["EUR 3.000", 3000],
    ["1,234,567.89", 1234567.89],
  ])("%s → %d", (raw, value) => {
    expect(parseAmount(raw)?.value).toBe(value);
  });
  it("rejects non-amounts", () => {
    expect(parseAmount("Account 1234-5678")).toBeNull();
    expect(parseAmount("1.2.3,4,5")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("dates", () => {
  it("parses unambiguous forms", () => {
    expect(parseDate("2025-03-31")).toBe("2025-03-31");
    expect(parseDate("31/03/2025")).toBe("2025-03-31");
    expect(parseDate("12 Mar 2025")).toBe("2025-03-12");
    expect(parseDate("March 12, 2025")).toBe("2025-03-12");
    expect(parseDate("1st Feb 2024")).toBe("2024-02-01");
  });
  it("refuses to guess ambiguous numeric dates without a hint", () => {
    expect(parseDate("03/04/2025")).toBeNull();
    expect(parseDate("03/04/2025", "DMY")).toBe("2025-04-03");
    expect(parseDate("03/04/2025", "MDY")).toBe("2025-03-04");
  });
  it("rejects impossible dates", () => {
    expect(parseDate("2025-02-30")).toBeNull();
  });
});

describe("arithmetic", () => {
  it("reconciles a statement", () => {
    expect(checkStatementBalance({ opening: 1000, credits: [2500], debits: [120.5, 79.5], closing: 3300 }).ok).toBe(true);
    const off = checkStatementBalance({ opening: 1000, transactions: [2500, -120.5], closing: 3300 });
    expect(off.ok).toBe(false);
    expect(off.difference).toBeCloseTo(79.5);
  });
  it("reconciles a payslip", () => {
    expect(checkPayslip({ gross: 5000, deductions: [750.25, 249.75], net: 4000 }).ok).toBe(true);
    expect(checkPayslip({ gross: 5000, deductions: [750.25], net: 4000 }).ok).toBe(false);
  });
});
