/**
 * Synthetic documents with known ground truth, for tests and the benchmark.
 * Every name, number and amount here is invented. No real documents are
 * used or needed — which is the point: nobody ever sees users' documents.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { composeTd3 } from "@pde/validators";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** Deterministic PRNG (mulberry32) so benchmark runs are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = ["DE VRIES", "JANSEN", "MULLER", "SCHMIDT", "GARCIA", "ROSSI", "NOVAK", "LINDQVIST", "OKAFOR", "TANAKA", "KOWALSKI", "DUBOIS", "SILVA", "OBRIEN", "NGUYEN"];
const GIVEN = ["SANNE", "PIETER", "ANNA MARIA", "LUCA", "AMARA", "KENJI", "ZOFIA", "ELENA", "MATEO", "INGRID", "TOMAS", "LEILA", "OSKAR", "MEI", "DAVID"];
const STATES = ["NLD", "DEU", "FRA", "ITA", "ESP", "POL", "SWE", "IRL", "PRT", "AUT", "BEL", "FIN", "DNK", "CZE", "GRC"];
const EMPLOYERS = ["Acme Widgets Ltd", "Northwind Trading BV", "Blue Harbor Logistics", "Globex Manufacturing", "Initech Services", "Umbrella Health Group"];

export interface PassportTruth {
  document_number: string;
  surname: string;
  given_names: string;
  nationality: string;
  date_of_birth: string;
  sex: string;
  date_of_expiry: string;
  issuing_country: string;
}

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}
function digits(r: () => number, n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(r() * 10);
  return s;
}
function yymmdd(y: number, m: number, d: number) {
  return `${String(y % 100).padStart(2, "0")}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}
function iso(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function randomPassport(seed: number) {
  const r = rng(seed);
  const state = pick(r, STATES);
  const by = 1950 + Math.floor(r() * 55), bm = 1 + Math.floor(r() * 12), bd = 1 + Math.floor(r() * 28);
  const ey = 2027 + Math.floor(r() * 9), em = 1 + Math.floor(r() * 12), ed = 1 + Math.floor(r() * 28);
  const sex = r() < 0.5 ? "F" : "M";
  const doc = `${String.fromCharCode(65 + Math.floor(r() * 26))}${String.fromCharCode(65 + Math.floor(r() * 26))}${digits(r, 7)}`;
  const surname = pick(r, SURNAMES);
  const given = pick(r, GIVEN);
  const mrz = composeTd3({
    issuingState: state, lastName: surname, firstName: given, documentNumber: doc, nationality: state,
    birthDate: yymmdd(by, bm, bd), sex, expirationDate: yymmdd(ey, em, ed),
  });
  const truth: PassportTruth = {
    document_number: doc, surname, given_names: given, nationality: state,
    date_of_birth: iso(by, bm, bd), sex: sex === "F" ? "female" : "male", date_of_expiry: iso(ey, em, ed), issuing_country: state,
  };
  return { truth, mrz };
}

export interface PhotoDistortion {
  /** Gaussian-ish blur radius in px. */
  blur?: number;
  /** Rotation in degrees. */
  rotate?: number;
  /** Pixel noise amplitude 0..255. */
  noise?: number;
  /** Brightness multiplier. */
  brightness?: number;
  /** Add a specular glare blob. */
  glare?: boolean;
  seed?: number;
}

function applyDistortion(ctx: SKRSContext2D, w: number, h: number, d: PhotoDistortion) {
  if (d.glare) {
    const g = ctx.createRadialGradient(w * 0.7, h * 0.3, 10, w * 0.7, h * 0.3, w * 0.35);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.97)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  if (d.noise || (d.brightness && d.brightness !== 1)) {
    const r = rng(d.seed ?? 1);
    const img = ctx.getImageData(0, 0, w, h);
    const b = d.brightness ?? 1;
    for (let i = 0; i < img.data.length; i += 4) {
      const n = d.noise ? (r() - 0.5) * 2 * d.noise : 0;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c]! * b + n));
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** Render a passport data page photo (PNG) with a VIZ and an MRZ. */
export function renderPassportPhoto(p: ReturnType<typeof randomPassport>, d: PhotoDistortion = {}): Buffer {
  const W = 1250, H = 880;
  const canvas = createCanvas(W + 120, H + 120);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#5b5e66"; // table behind the document
  ctx.fillRect(0, 0, W + 120, H + 120);
  ctx.save();
  ctx.translate(60 + W / 2, 60 + H / 2);
  ctx.rotate(((d.rotate ?? 0) * Math.PI) / 180);
  ctx.translate(-W / 2, -H / 2);
  if (d.blur) ctx.filter = `blur(${d.blur}px)`;
  ctx.fillStyle = "#efe9dc";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#b9c4d6";
  ctx.fillRect(40, 150, 300, 380); // photo placeholder
  ctx.fillStyle = "#1d2a44";
  ctx.font = "bold 34px DejaVu Sans";
  ctx.fillText("PASSPORT", 40, 70);
  ctx.font = "22px DejaVu Sans";
  ctx.fillText(`Type P   Code ${p.truth.issuing_country}   Passport No. ${p.truth.document_number}`, 40, 120);
  const viz: [string, string][] = [
    ["Surname", p.truth.surname],
    ["Given names", p.truth.given_names],
    ["Nationality", p.truth.nationality],
    ["Date of birth", p.truth.date_of_birth],
    ["Sex", p.truth.sex === "female" ? "F" : "M"],
    ["Date of expiry", p.truth.date_of_expiry],
  ];
  viz.forEach(([label, value], i) => {
    ctx.fillStyle = "#4a5568";
    ctx.font = "18px DejaVu Sans";
    ctx.fillText(label, 380, 175 + i * 62);
    ctx.fillStyle = "#111";
    ctx.font = "26px DejaVu Sans";
    ctx.fillText(value, 380, 203 + i * 62);
  });
  ctx.fillStyle = "#111";
  ctx.font = "34px DejaVu Sans Mono";
  ctx.fillText(p.mrz[0], 40, H - 110);
  ctx.fillText(p.mrz[1], 40, H - 50);
  ctx.restore();
  applyDistortion(ctx, W + 120, H + 120, d);
  return canvas.toBuffer("image/png");
}

export interface PayslipTruth {
  employer_name: string;
  employee_name: string;
  employee_id: string;
  pay_period: string;
  pay_date: string;
  gross_pay: string;
  total_deductions: string;
  net_pay: string;
}

export function randomPayslip(seed: number): { truth: PayslipTruth; rows: [string, string][]; header: string[] } {
  const r = rng(seed);
  const basic = 2000 + Math.round(r() * 600000) / 100;
  const overtime = Math.round(r() * 80000) / 100;
  const gross = basic + overtime;
  const tax = Math.round(gross * (0.12 + r() * 0.2) * 100) / 100;
  const pension = Math.round(gross * 0.05 * 100) / 100;
  const deductions = Math.round((tax + pension) * 100) / 100;
  const net = Math.round((gross - deductions) * 100) / 100;
  const month = 1 + Math.floor(r() * 12);
  const last = new Date(Date.UTC(2025, month, 0)).getUTCDate();
  const employer = pick(r, EMPLOYERS);
  const name = `${pick(r, GIVEN).split(" ")[0]![0]}${pick(r, GIVEN).split(" ")[0]!.slice(1).toLowerCase()} ${pick(r, SURNAMES).split(" ").map((s) => s[0] + s.slice(1).toLowerCase()).join(" ")}`;
  const eid = `E-${digits(r, 5)}`;
  const fmt = (n: number) => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const mm = String(month).padStart(2, "0");
  return {
    truth: {
      employer_name: employer,
      employee_name: name,
      employee_id: eid,
      pay_period: `2025-${mm}-01/2025-${mm}-${last}`,
      pay_date: `2025-${mm}-${String(last - 2).padStart(2, "0")}`,
      gross_pay: gross.toFixed(2),
      total_deductions: deductions.toFixed(2),
      net_pay: net.toFixed(2),
    },
    header: [
      employer,
      "PAYSLIP",
      `Employer: ${employer}`,
      `Employee Name: ${name}`,
      `Employee ID: ${eid}`,
      `Pay Period: 01/${mm}/2025 - ${last}/${mm}/2025`,
      `Pay Date: ${last - 2}/${mm}/2025`,
    ],
    rows: [
      ["Basic Salary", fmt(basic)],
      ["Overtime", fmt(overtime)],
      ["Gross Pay", fmt(gross)],
      ["Income Tax", fmt(tax)],
      ["Pension", fmt(pension)],
      ["Total Deductions", fmt(deductions)],
      ["Net Pay", fmt(net)],
    ],
  };
}

/** Digital payslip PDF with a real text layer. */
export async function payslipPdf(p: ReturnType<typeof randomPayslip>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  p.header.forEach((line, i) => {
    page.drawText(line, { x: 50, y, size: i < 2 ? 16 : 11, font: i < 2 ? bold : font, color: rgb(0.1, 0.1, 0.15) });
    y -= i < 2 ? 26 : 18;
  });
  y -= 20;
  page.drawText("Description", { x: 50, y, size: 11, font: bold });
  page.drawText("Amount", { x: 420, y, size: 11, font: bold });
  y -= 22;
  for (const [label, amount] of p.rows) {
    page.drawText(label, { x: 50, y, size: 11, font });
    const w = font.widthOfTextAtSize(amount, 11);
    page.drawText(amount, { x: 480 - w, y, size: 11, font });
    y -= 20;
  }
  page.drawText("This payslip is confidential. Keep it safe.", { x: 50, y: 60, size: 8, font });
  return doc.save();
}

/** The same payslip printed and photographed/scanned (PNG, no text layer). */
export function payslipPhoto(p: ReturnType<typeof randomPayslip>, d: PhotoDistortion = {}): Buffer {
  const W = 1240, H = 1754;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fdfdfb";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(((d.rotate ?? 0) * Math.PI) / 180);
  ctx.translate(-W / 2, -H / 2);
  if (d.blur) ctx.filter = `blur(${d.blur}px)`;
  ctx.fillStyle = "#151515";
  let y = 130;
  p.header.forEach((line, i) => {
    ctx.font = i < 2 ? "bold 40px DejaVu Sans" : "28px DejaVu Sans";
    ctx.fillText(line, 100, y);
    y += i < 2 ? 64 : 46;
  });
  y += 50;
  ctx.font = "bold 28px DejaVu Sans";
  ctx.fillText("Description", 100, y);
  ctx.fillText("Amount", 880, y);
  y += 56;
  ctx.font = "28px DejaVu Sans";
  for (const [label, amount] of p.rows) {
    ctx.fillText(label, 100, y);
    const w = ctx.measureText(amount).width;
    ctx.fillText(amount, 1000 - w, y);
    y += 50;
  }
  ctx.restore();
  applyDistortion(ctx, W, H, d);
  return canvas.toBuffer("image/png");
}

export interface StatementTruth {
  account_holder: string;
  iban: string;
  statement_period: string;
  opening_balance: string;
  total_credits: string;
  total_debits: string;
  closing_balance: string;
}

function ibanFor(r: () => number): string {
  // Build a valid GB IBAN: GBkk BANK 123456 12345678
  const bban = `WEST${digits(r, 14)}`;
  const rearranged = `${bban}GB00`;
  let rem = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const dgt of v) rem = (rem * 10 + Number(dgt)) % 97;
  }
  return `GB${String(98 - rem).padStart(2, "0")}${bban}`;
}

export function randomStatement(seed: number) {
  const r = rng(seed);
  const holder = `${pick(r, GIVEN).split(" ")[0]!} ${pick(r, SURNAMES)}`.replace(/\b(\w)(\w*)/g, (_, a: string, b: string) => a + b.toLowerCase());
  const iban = ibanFor(r);
  let balance = Math.round(r() * 500000) / 100;
  const opening = balance;
  const tx: { date: string; desc: string; amount: number; balance: number }[] = [];
  let credits = 0, debits = 0;
  const n = 5 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const credit = r() < 0.3;
    const amount = Math.round(r() * (credit ? 300000 : 40000)) / 100;
    balance = Math.round((balance + (credit ? amount : -amount)) * 100) / 100;
    if (credit) credits += amount;
    else debits += amount;
    tx.push({ date: `${String(2 + i * 2).padStart(2, "0")}/03/2025`, desc: credit ? "Salary payment" : pick(r, ["Grocery store", "Utilities", "Rent", "Card payment", "Pharmacy"]), amount: credit ? amount : -amount, balance });
  }
  const fmt = (v: number) => v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    truth: {
      account_holder: holder,
      iban,
      statement_period: "2025-03-01/2025-03-31",
      opening_balance: opening.toFixed(2),
      total_credits: credits.toFixed(2),
      total_debits: debits.toFixed(2),
      closing_balance: balance.toFixed(2),
    } satisfies StatementTruth,
    header: ["Example Bank plc", `Account Holder: ${holder}`, `IBAN: ${iban.replace(/(.{4})/g, "$1 ").trim()}`, "Statement Period: 1 Mar 2025 to 31 Mar 2025"],
    opening: fmt(opening),
    tx: tx.map((t) => [t.date, t.desc, fmt(Math.abs(t.amount)), fmt(t.balance)] as [string, string, string, string]),
    totals: [["Total Money In", fmt(credits)], ["Total Money Out", fmt(debits)], ["Closing Balance", fmt(balance)]] as [string, string][],
  };
}

export async function statementPdf(s: ReturnType<typeof randomStatement>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  s.header.forEach((line, i) => {
    page.drawText(line, { x: 50, y, size: i === 0 ? 16 : 11, font: i === 0 ? bold : font });
    y -= i === 0 ? 28 : 18;
  });
  y -= 16;
  page.drawText("Opening Balance", { x: 50, y, size: 11, font });
  page.drawText(s.opening, { x: 545 - font.widthOfTextAtSize(s.opening, 11), y, size: 11, font });
  y -= 30;
  for (const [h, x] of [["Date", 50], ["Description", 130], ["Amount", 400], ["Balance", 500]] as const) page.drawText(h, { x, y, size: 10, font: bold });
  y -= 18;
  for (const [date, desc, amount, bal] of s.tx) {
    page.drawText(date, { x: 50, y, size: 10, font });
    page.drawText(desc, { x: 130, y, size: 10, font });
    page.drawText(amount, { x: 445 - font.widthOfTextAtSize(amount, 10), y, size: 10, font });
    page.drawText(bal, { x: 545 - font.widthOfTextAtSize(bal, 10), y, size: 10, font });
    y -= 16;
  }
  y -= 14;
  for (const [label, v] of s.totals) {
    page.drawText(label, { x: 50, y, size: 11, font });
    page.drawText(v, { x: 545 - font.widthOfTextAtSize(v, 11), y, size: 11, font });
    y -= 18;
  }
  return doc.save();
}
