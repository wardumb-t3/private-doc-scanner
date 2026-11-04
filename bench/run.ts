/**
 * Accuracy benchmark on synthetic documents with known ground truth.
 *
 *   pnpm bench               # default 20 docs per scenario
 *   pnpm bench -- --n 50
 *
 * Reports, per scenario:
 * - field accuracy: extracted value == truth
 * - auto-accept accuracy: of fields NOT flagged for review, how many are right
 *   (what a user who only checks flagged fields would submit)
 * - validated-but-wrong: fields a deterministic check vouched for that are
 *   wrong — the trust guarantee; must stay 0
 * - review rate and median latency
 */
import { mkdir, writeFile } from "node:fs/promises";
import { extractDocument, type DocType, type DocumentInput, type ExtractionResult } from "@pde/core";
import { createNodeEngines } from "@pde/engines-web/node";
import {
  payslipPdf,
  payslipPhoto,
  randomPassport,
  randomPayslip,
  randomStatement,
  renderPassportPhoto,
  statementPdf,
  type PhotoDistortion,
} from "./synth.ts";

const argN = process.argv.indexOf("--n");
const N = argN > 0 ? Number(process.argv[argN + 1]) : 20;
const VERBOSE = process.argv.includes("--verbose");
const argOnly = process.argv.indexOf("--only");
const ONLY = argOnly > 0 ? process.argv[argOnly + 1]! : "";

interface Scenario {
  name: string;
  docType: DocType;
  make(seed: number): Promise<{ input: DocumentInput; truth: Record<string, string> }>;
}

const bytes = (b: Uint8Array | Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const png = (b: Buffer, name: string): DocumentInput => ({ name, mime: "image/png", bytes: bytes(b) });
const pdf = (b: Uint8Array, name: string): DocumentInput => ({ name, mime: "application/pdf", bytes: bytes(b) });

function photo(seed: number, level: "clean" | "phone"): PhotoDistortion {
  if (level === "clean") return {};
  const r = (k: number) => ((Math.sin(seed * 9301 + k * 49297) + 1) / 2);
  return { rotate: (r(1) - 0.5) * 6, noise: 8 + r(2) * 16, blur: r(3) < 0.4 ? 0.8 : 0, brightness: 0.85 + r(4) * 0.25, seed };
}

const scenarios: Scenario[] = [
  { name: "passport photo (clean)", docType: "passport", make: async (s) => { const p = randomPassport(s); return { input: png(renderPassportPhoto(p, photo(s, "clean")), "p.png"), truth: { ...p.truth } }; } },
  { name: "passport photo (phone-like: ±3° tilt, noise, blur)", docType: "passport", make: async (s) => { const p = randomPassport(s); return { input: png(renderPassportPhoto(p, photo(s, "phone")), "p.png"), truth: { ...p.truth } }; } },
  { name: "payslip PDF (digital)", docType: "payslip", make: async (s) => { const p = randomPayslip(s); return { input: pdf(await payslipPdf(p), "p.pdf"), truth: { ...p.truth } }; } },
  { name: "payslip photo (phone-like)", docType: "payslip", make: async (s) => { const p = randomPayslip(s); return { input: png(payslipPhoto(p, photo(s, "phone")), "p.png"), truth: { ...p.truth } }; } },
  { name: "bank statement PDF (digital)", docType: "bank_statement", make: async (s) => { const st = randomStatement(s); return { input: pdf(await statementPdf(st), "s.pdf"), truth: { ...st.truth } }; } },
];

interface Tally {
  fields: number;
  correct: number;
  autoAccepted: number;
  autoAcceptedCorrect: number;
  validated: number;
  validatedWrong: number;
  flagged: number;
  docs: number;
  docsAllCorrect: number;
  ms: number[];
}

function score(r: ExtractionResult, truth: Record<string, string>, t: Tally) {
  let all = true;
  for (const [key, want] of Object.entries(truth)) {
    const f = r.fields.find((x) => x.key === key);
    const ok = f?.value === want;
    t.fields++;
    if (ok) t.correct++;
    else all = false;
    if (f && f.value !== null && !f.needsReview) {
      t.autoAccepted++;
      if (ok) t.autoAcceptedCorrect++;
    } else if (f?.needsReview) t.flagged++;
    if (f?.validated) {
      t.validated++;
      if (!ok) {
        t.validatedWrong++;
        console.error(`  ! validated but wrong: ${key} = ${JSON.stringify(f.value)} (want ${JSON.stringify(want)}) via ${f.validatedBy.join(",")}`);
      }
    }
  }
  t.docs++;
  if (all) t.docsAllCorrect++;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);

const engines = await createNodeEngines();
const rows: string[] = [];
let totalValidatedWrong = 0;
for (const sc of scenarios.filter((s) => s.name.includes(ONLY))) {
  const t: Tally = { fields: 0, correct: 0, autoAccepted: 0, autoAcceptedCorrect: 0, validated: 0, validatedWrong: 0, flagged: 0, docs: 0, docsAllCorrect: 0, ms: [] };
  for (let i = 0; i < N; i++) {
    const seed = 1000 + i;
    const { input, truth } = await sc.make(seed);
    const t0 = performance.now();
    const r = await extractDocument(input, engines, { docType: sc.docType, previewSide: 0 });
    t.ms.push(performance.now() - t0);
    score(r, truth, t);
    if (VERBOSE) {
      const misses = Object.entries(truth).filter(([k, v]) => r.fields.find((f) => f.key === k)?.value !== v);
      if (misses.length) console.log(`  seed ${seed}: ${misses.map(([k, v]) => `${k}=${JSON.stringify(r.fields.find((f) => f.key === k)?.value)}≠${JSON.stringify(v)}`).join(" ")} ${r.warnings.join(" ")}`);
    }
  }
  totalValidatedWrong += t.validatedWrong;
  const row = `| ${sc.name} | ${t.docs} | ${pct(t.correct, t.fields)} | ${pct(t.docsAllCorrect, t.docs)} | ${pct(t.autoAcceptedCorrect, t.autoAccepted)} | ${pct(t.flagged, t.fields)} | ${t.validatedWrong} / ${t.validated} | ${Math.round(median(t.ms))} ms |`;
  rows.push(row);
  console.log(row);
}
await engines.dispose();

const report = `# Benchmark — synthetic documents

Generated by \`pnpm bench\` (${N} documents per scenario, Node, ONNX Runtime WASM single-thread, PP-OCRv4 mobile).
All documents are synthetic; see \`bench/synth.ts\`.

| Scenario | Docs | Field accuracy | Docs fully correct | Auto-accepted fields correct | Fields flagged for review | Validated but wrong | Median time |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

- **Field accuracy**: extracted value equals ground truth before any user review.
- **Auto-accepted fields correct**: fields *not* flagged for review — what gets submitted if the user only fixes flagged fields.
- **Validated but wrong**: a check digit / checksum / arithmetic check vouched for a wrong value. This is the trust guarantee and must be 0.
`;
await mkdir(new URL("./out/", import.meta.url), { recursive: true });
await writeFile(new URL("./out/report.md", import.meta.url), report);
console.log(`\nreport: bench/out/report.md`);
if (totalValidatedWrong > 0) process.exitCode = 1;
