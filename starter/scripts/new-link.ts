/**
 * A capture link with a fresh, unguessable request id. Opening it on a phone
 * reads the documents on the device; the user seals them to their own vault.
 * Needs no key and makes no network call.
 *
 *   npx tsx scripts/new-link.ts passport,payslip
 */
import { randomBytes } from "node:crypto";

const TYPES = ["passport", "id_card", "payslip", "bank_statement", "generic"];
const APP = (process.env.PDE_CAPTURE_URL ?? "https://experiments-eta-ten.vercel.app/").replace(/\/?$/, "/");

const arg = process.argv.slice(2).find((a) => a !== "--") ?? "";
const types = arg.split(",").map((t) => t.trim()).filter(Boolean);
const bad = types.filter((t) => !TYPES.includes(t));
if (bad.length) {
  console.error(`unknown document type(s): ${bad.join(", ")}. Use: ${TYPES.join(", ")}`);
  process.exit(2);
}

// 128 random bits; the first account to seal to an id owns it, so it must not be guessable.
const requestId = `vault_${randomBytes(16).toString("hex")}`;
// Both values are URL-safe as they are; written out so the link reads cleanly in chat.
const link = `${APP}?req=${requestId}${types.length ? `&types=${types.join(",")}` : ""}`;

console.log(JSON.stringify({ request_id: requestId, link }, null, 2));
