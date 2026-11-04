/**
 * Ask your vault about a submission. The contract answers from inside the
 * enclave with presence, verification status and rule results: never values.
 *
 *   npx tsx scripts/vault.ts status <request_id>
 *   npx tsx scripts/vault.ts evaluate <request_id> '{"min_net_pay":"3000.00","require_verified":true}'
 */
import { NODE_URL, onFailure, sdk, signIn } from "./t3n.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const args = process.argv.slice(2).filter((a) => a !== "--");
const [fn, requestId, rulesJson] = args;
if ((fn !== "status" && fn !== "evaluate") || !requestId) {
  console.error("usage: vault.ts status <request_id> | vault.ts evaluate <request_id> '<rules json>'");
  process.exit(2);
}
let rules: unknown = undefined;
if (fn === "evaluate") {
  try {
    rules = JSON.parse(rulesJson ?? "");
  } catch {
    console.error('evaluate needs rules as JSON, e.g. \'{"min_net_pay":"3000.00"}\'');
    process.exit(2);
  }
}

const { client, tenant } = await signIn();
const contract = tenant.canonicalName("doc-intake");
const version = await sdk.getContractVersion(NODE_URL, contract).catch(() => null);
if (!version) {
  console.error(`✗ no vault at ${contract} yet. Run: npx tsx scripts/setup-vault.ts`);
  process.exit(1);
}
const out = await client.executeAndDecode({
  contract_id: contract,
  contract_version: version,
  function_name: fn,
  input: fn === "evaluate" ? { request_id: requestId, rules } : { request_id: requestId },
});
console.log(JSON.stringify(out, null, 2));
