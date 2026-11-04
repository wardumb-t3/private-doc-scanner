/**
 * PRINTS YOUR PRIVATE VALUES. Read one entry of your own vault back, exactly
 * as stored, to check that what was sealed matches your document.
 *
 * Run it yourself, in your own terminal. Never in an AI chat or a shared
 * screen: the output is your document data.
 *
 *   npx tsx scripts/read-my-data.ts <request_id>
 *
 * This works because you own the vault's maps: the map ACL limits other
 * contracts, not the owner (see the T3 docs on storage namespaces).
 */
import { onFailure, signIn } from "./t3n.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const requestId = process.argv.slice(2).find((a) => a !== "--");
if (!requestId) {
  console.error("usage: read-my-data.ts <request_id>   (prints your private values)");
  process.exit(2);
}

const { did, tenant } = await signIn();
const raw = await tenant.maps.entryGet("intake", `req:${requestId}`);
if (raw === null) {
  console.error(`✗ nothing stored under ${requestId} in ${tenant.canonicalName("intake")} (signed in as ${did})`);
  process.exit(1);
}
let record: unknown = raw;
try {
  record = JSON.parse(raw);
} catch {
  // Not JSON: print as stored.
}
console.log(typeof record === "string" ? record : JSON.stringify(record, null, 2));
