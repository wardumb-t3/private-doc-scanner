/**
 * End-to-end check against a real T3 node, from a server or laptop:
 * synthetic documents → on-device pipeline (Node build) → attested, encrypted
 * submission to doc-intake → status (no values) → evaluate (yes/no).
 *
 *   T3N_API_KEY=0x… pnpm t3:smoke
 *   T3N_BASE_URL=https://capture.example.com/t3 T3N_API_KEY=0x… pnpm t3:smoke   # through your relay
 */
import { buildSubmission, extractDocument, type DocumentInput } from "@pde/core";
import { createNodeEngines } from "@pde/engines-web/node";
import { T3nDestination } from "@pde/adapter-t3n";
import { payslipPdf, randomPassport, randomPayslip, renderPassportPhoto } from "@pde/bench/synth";
import { baseUrl, env, networkEnv, readDeployment, sdk, onFailure } from "./common.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const e = networkEnv();
const url = baseUrl(e);
const key = env("T3N_API_KEY");
const dep = await readDeployment();
const asInput = (b: Uint8Array | Buffer, mime: string, name: string): DocumentInput => ({
  name,
  mime,
  bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
});

console.log("1/5 extracting synthetic documents on this machine…");
const engines = await createNodeEngines();
const passport = randomPassport(Date.now() % 10_000);
const payslip = randomPayslip(Date.now() % 10_000);
const results = [
  await extractDocument(asInput(renderPassportPhoto(passport), "image/png", "passport.png"), engines, { docType: "passport", previewSide: 0 }),
  await extractDocument(asInput(await payslipPdf(payslip), "application/pdf", "payslip.pdf"), engines, { docType: "payslip", previewSide: 0 }),
];
await engines.dispose();
const requestId = `req_smoke_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const submission = buildSubmission({ requestId, results, client: { name: "private-doc-scanner", version: "smoke", engine: "node" } });
console.log(`   ${submission.documents.map((d) => `${d.doc_type}: ${Object.keys(d.fields).length} fields`).join(", ")}`);

console.log(`2/5 attested handshake with ${url} and wallet sign-in…`);
const address = sdk.eth_get_address(key);
const dest = new T3nDestination({
  baseUrl: url,
  environment: e,
  target: { kind: "contract", contractId: dep.contract, functionName: "ingest" },
  handlers: (s) => ({ EthSign: s.metamask_sign(address, undefined, key) }),
  authenticate: async (client, s) => {
    await client.authenticate(s.createEthAuthInput(address));
  },
});
await dest.prepare();

console.log("3/5 sealing and sending (ingest)…");
const receipt = await dest.submit(submission);
console.log(`   reference: ${receipt.reference}`);

const client = dest.session!;
const version = await sdk.getContractVersion(url, dep.contract);
const call = (fn: string, input: unknown) =>
  client.executeAndDecode<Record<string, unknown>>({ contract_id: dep.contract, contract_version: version, function_name: fn, input });

console.log("4/5 status (what an agent sees — no values)…");
const status = await call("status", { request_id: requestId });
console.log(JSON.stringify(status, null, 2));
const leaked = [passport.truth.document_number, passport.truth.date_of_birth, payslip.truth.net_pay].filter((v) => JSON.stringify(status).includes(v));
if (leaked.length) throw new Error(`status leaked values: ${leaked.join(", ")}`);

console.log("5/5 evaluate (yes/no decisions computed in the enclave)…");
const decision = await call("evaluate", {
  request_id: requestId,
  rules: { min_net_pay: "1000.00", min_age: 18, document_not_expired: true, require_verified: true },
});
console.log(JSON.stringify(decision, null, 2));
console.log(`\n✓ end to end against ${e}. Agents can now look up request ${requestId}.`);
